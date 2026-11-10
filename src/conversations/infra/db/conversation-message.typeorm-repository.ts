import { Injectable } from '@nestjs/common';
import { DataSource, IsNull } from 'typeorm';
import type { ConversationScope } from '../../domain/conversation-actor.js';
import { conversationNotFound } from '../../domain/conversation-errors.js';
import { ConversationMessageRepository } from '../../domain/conversation-message.repository.js';
import type { ConversationMessage } from '../../domain/conversation-message.js';
import { ConversationMessageTypeormEntity } from './conversation-message.entity.js';
import { inScope } from './conversation-scope.js';
import { messageToDomain, messageToInsert } from './conversation.mapper.js';

@Injectable()
export class ConversationMessageTypeormRepository extends ConversationMessageRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Reenvio do mesmo id não duplica: ON CONFLICT (id) DO NOTHING.
  async insertIfAbsent(
    scope: ConversationScope,
    message: ConversationMessage,
  ): Promise<boolean> {
    const result = await inScope(this.dataSource, scope, (m) =>
      m
        .getRepository(ConversationMessageTypeormEntity)
        .createQueryBuilder()
        .insert()
        .values(messageToInsert(message))
        .orIgnore()
        .returning('id')
        .execute(),
    );
    return (result.raw as unknown[]).length > 0;
  }

  async findById(
    scope: ConversationScope,
    id: string,
    options: { withDeleted?: boolean } = {},
  ): Promise<ConversationMessage | null> {
    const row = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationMessageTypeormEntity).findOne({
        where: { id, organizationId: scope.organizationId },
        withDeleted: options.withDeleted ?? false,
      }),
    );
    return row ? messageToDomain(row) : null;
  }

  async save(
    scope: ConversationScope,
    message: ConversationMessage,
  ): Promise<void> {
    const result = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationMessageTypeormEntity).update(
        { id: message.id, organizationId: scope.organizationId },
        {
          pending: message.pending,
          ackedAt: message.ackedAt,
          encryptedBody: message.encryptedBody,
          deletedAt: message.deletedAt,
        },
      ),
    );
    if (!result.affected) throw conversationNotFound();
  }

  async listPending(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<ConversationMessage[]> {
    const rows = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationMessageTypeormEntity).find({
        where: {
          organizationId: scope.organizationId,
          conversationId,
          pending: true,
          deletedAt: IsNull(),
        },
        order: { sentAt: 'ASC', id: 'ASC' },
      }),
    );
    return rows.map(messageToDomain);
  }
}
