import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import {
  conversationMoveInvalid,
  conversationNotFound,
} from '../domain/conversation-errors.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { ConversationAccess, reachable } from './conversation-access.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';

export type MoveConversationInput = {
  /** The space of the conversation created with `movedFrom` = this one. */
  toSpaceId: string;
  toConversationId: string;
};

// Concluir a mudança de espaço (spec §4.2; a primeira parte é criar no destino com `movedFrom`, em
// `CreateConversationUseCase`): só o DONO do assunto antigo (403 `not-conversation-owner`), membro dos dois espaços e
// participante do novo (404 `conversation-not-found` para o resto), e o novo precisa ter `movedFromConversationId` =
// este (422 `conversation-move-invalid`). O antigo ganha lápide (relógio do banco): as participações, as cópias e o
// executor ficam como estão, e a sincronização entrega a lápide do assunto (o cliente apaga o local, contrato da Task
// 6); mensagens e anexos dele entram na janela de 30 dias da retenção a partir da lápide. Auditoria
// `conversation.moved` na organização do antigo, só ids. Repetir depois da lápide: 204, nada muda.
// Locks: só o assunto antigo (FOR UPDATE); o novo é só lido.
@Injectable()
export class MoveConversationUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly conversations: ConversationRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly reserve: ConversationCloudReserve,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    input: MoveConversationInput,
  ): Promise<void> {
    const { userId } = actor;
    return this.uow.run(async () => {
      await this.uow.setContext({ userId });
      const { conversation: target } = await this.access.findForUser(
        input.toSpaceId,
        input.toConversationId,
        actor,
      );
      if (
        target.movedFromConversationId !== conversationId ||
        target.spaceId === spaceId
      ) {
        throw conversationMoveInvalid();
      }
      const scope = await this.access.userScope(spaceId, actor);
      const source = await this.conversations.lockById(scope, conversationId);
      if (!source) {
        // Já movido (repetição depois de uma falha de rede): o dono ainda participa e vê a lápide.
        const gone = await this.conversations.findById(scope, conversationId, {
          withDeleted: true,
        });
        if (gone?.deletedAt && reachable(scope, gone, spaceId)) {
          gone.assertOwner(userId);
          return;
        }
        throw conversationNotFound();
      }
      reachable(scope, source, spaceId);
      source.assertOwner(userId);
      const hadCloudReserve = source.cloudReserve;
      source.tombstone(await this.messages.databaseNow());
      await this.conversations.save(scope, source);
      // The tombstone takes the cloud reserve with it: the server copies of the old conversation go away.
      if (hadCloudReserve) await this.reserve.dropServerSide(scope, source);
      await this.audit.record({
        organizationId: source.organizationId,
        userId,
        action: 'conversation.moved',
        metadata: {
          conversationId: source.id,
          spaceId: source.spaceId,
          toConversationId: target.id,
          toSpaceId: target.spaceId,
          toOrganizationId: target.organizationId,
        },
      });
    });
  }
}
