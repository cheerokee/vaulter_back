import { Injectable } from '@nestjs/common';
import { DataSource, QueryFailedError } from 'typeorm';
import type { ConversationScope } from '../../domain/conversation-actor.js';
import {
  conversationIdConflict,
  conversationNotFound,
} from '../../domain/conversation-errors.js';
import {
  ConversationRepository,
  type ConversationLockMode,
} from '../../domain/conversation.repository.js';
import type { Conversation } from '../../domain/conversation.js';
import { ConversationParticipantTypeormEntity } from './conversation-participant.entity.js';
import { inScope, requireUnitOfWork } from './conversation-scope.js';
import {
  conversationMutable,
  conversationToDomain,
  conversationToInsert,
} from './conversation.mapper.js';
import { ConversationTypeormEntity } from './conversation.entity.js';

const LOCK_MODES = {
  update: 'pessimistic_write',
  'no-key-update': 'for_no_key_update',
  'key-share': 'for_key_share',
} as const satisfies Record<ConversationLockMode, string>;

@Injectable()
export class ConversationTypeormRepository extends ConversationRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // A conversa nasce com participant_user_ids = [dono] (trigger) e a participação do dono entra na mesma transação,
  // então a lista derivada e as participações nunca divergem.
  // Id já usado (por um assunto que o escopo nem vê): 409 `conversation-id-conflict`, nunca o 409 genérico. O erro
  // nasce dentro do savepoint do escopo, que é desfeito; quem chama não segue (o erro sobe).
  async create(scope: ConversationScope, c: Conversation): Promise<void> {
    await inScope(this.dataSource, scope, async (m) => {
      try {
        await m
          .getRepository(ConversationTypeormEntity)
          .insert(conversationToInsert(c));
      } catch (e) {
        if (
          e instanceof QueryFailedError &&
          (e.driverError as { code?: string; constraint?: string }).code ===
            '23505' &&
          (e.driverError as { constraint?: string }).constraint ===
            'PK_conversations'
        ) {
          throw conversationIdConflict();
        }
        throw e;
      }
      await m.getRepository(ConversationParticipantTypeormEntity).insert({
        organizationId: c.organizationId,
        conversationId: c.id,
        userId: c.ownerUserId,
        joinedAt: c.createdAt ?? new Date(),
      });
    });
  }

  async findById(
    scope: ConversationScope,
    id: string,
    options: { withDeleted?: boolean } = {},
  ): Promise<Conversation | null> {
    const row = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationTypeormEntity).findOne({
        where: { id, organizationId: scope.organizationId },
        withDeleted: options.withDeleted ?? false,
      }),
    );
    return row ? conversationToDomain(row) : null;
  }

  async lockById(
    scope: ConversationScope,
    id: string,
    mode: ConversationLockMode = 'update',
  ): Promise<Conversation | null> {
    requireUnitOfWork(this.dataSource, 'ConversationRepository.lockById');
    const row = await inScope(this.dataSource, scope, (m) =>
      m
        .getRepository(ConversationTypeormEntity)
        .createQueryBuilder('c')
        .where('c.id = :id AND c.organization_id = :org', {
          id,
          org: scope.organizationId,
        })
        .setLock(LOCK_MODES[mode])
        .getOne(),
    );
    return row ? conversationToDomain(row) : null;
  }

  // 0 linhas = a conversa não é (mais) visível no escopo: erro, nunca um no-op silencioso (ex.: quem sai gravando depois
  // da lápide da própria participação).
  async save(scope: ConversationScope, c: Conversation): Promise<void> {
    const result = await inScope(this.dataSource, scope, (m) =>
      m
        .getRepository(ConversationTypeormEntity)
        .update(
          { id: c.id, organizationId: scope.organizationId },
          conversationMutable(c),
        ),
    );
    if (!result.affected) throw conversationNotFound();
  }

  // Toda rota que trava vários assuntos os trava em ordem (espaço, assunto): a saída da organização emite a saída de
  // cada espaço em ordem de id do espaço, e o executor perdido numa organização inteira percorre todos os espaços.
  // Ordem só por id daria deadlock (40P01) entre as duas.
  async idsWithParticipant(
    scope: ConversationScope,
    spaceId: string,
    userId: string,
  ): Promise<string[]> {
    const rows: { id: string }[] = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `SELECT id FROM conversations
          WHERE organization_id = $1 AND space_id = $2 AND $3 = ANY (participant_user_ids)
            AND deleted_at IS NULL
          ORDER BY space_id, id`,
        [scope.organizationId, spaceId, userId],
      ),
    );
    return rows.map((r) => r.id);
  }

  async idsWithCloudReserve(
    scope: ConversationScope,
    spaceId: string,
  ): Promise<string[]> {
    const rows: { id: string }[] = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `SELECT id FROM conversations
          WHERE organization_id = $1 AND space_id = $2 AND cloud_reserve AND deleted_at IS NULL
          ORDER BY space_id, id`,
        [scope.organizationId, spaceId],
      ),
    );
    return rows.map((r) => r.id);
  }

  async idsWithExecutor(
    scope: ConversationScope,
    hubId: string,
    spaceId: string | null = null,
  ): Promise<string[]> {
    const rows: { id: string }[] = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `SELECT id FROM conversations
          WHERE organization_id = $1 AND executor_hub_id = $2 AND deleted_at IS NULL
            AND ($3::uuid IS NULL OR space_id = $3::uuid)
          ORDER BY space_id, id`,
        [scope.organizationId, hubId, spaceId],
      ),
    );
    return rows.map((r) => r.id);
  }
}
