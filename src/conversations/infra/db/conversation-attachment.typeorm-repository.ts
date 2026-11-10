import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { ConversationScope } from '../../domain/conversation-actor.js';
import { conversationNotFound } from '../../domain/conversation-errors.js';
import { ConversationAttachmentRepository } from '../../domain/conversation-attachment.repository.js';
import type { ConversationAttachment } from '../../domain/conversation-attachment.js';
import { ConversationAttachmentTypeormEntity } from './conversation-attachment.entity.js';
import { inScope } from './conversation-scope.js';
import {
  attachmentMutable,
  attachmentToDomain,
  attachmentToInsert,
} from './conversation.mapper.js';

@Injectable()
export class ConversationAttachmentTypeormRepository extends ConversationAttachmentRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async create(
    scope: ConversationScope,
    a: ConversationAttachment,
  ): Promise<void> {
    await inScope(this.dataSource, scope, (m) =>
      m
        .getRepository(ConversationAttachmentTypeormEntity)
        .insert(attachmentToInsert(a)),
    );
  }

  async findById(
    scope: ConversationScope,
    id: string,
    options: { withDeleted?: boolean } = {},
  ): Promise<ConversationAttachment | null> {
    const row = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationAttachmentTypeormEntity).findOne({
        where: { id, organizationId: scope.organizationId },
        withDeleted: options.withDeleted ?? false,
      }),
    );
    return row ? attachmentToDomain(row) : null;
  }

  async save(
    scope: ConversationScope,
    a: ConversationAttachment,
  ): Promise<void> {
    const result = await inScope(this.dataSource, scope, (m) =>
      m
        .getRepository(ConversationAttachmentTypeormEntity)
        .update(
          { id: a.id, organizationId: scope.organizationId },
          attachmentMutable(a),
        ),
    );
    // 0 linhas = a conversa não é (mais) visível no escopo: erro, nunca um no-op silencioso.
    if (!result.affected) throw conversationNotFound();
  }
}
