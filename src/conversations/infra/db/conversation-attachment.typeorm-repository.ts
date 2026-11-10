import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { validate } from 'uuid';
import {
  currentManager,
  runWithContext,
} from '../../../shared/infra/db/unit-of-work.js';
import type {
  ConversationActor,
  ConversationScope,
} from '../../domain/conversation-actor.js';
import { conversationNotFound } from '../../domain/conversation-errors.js';
import {
  ConversationAttachmentRepository,
  type MarkedAttachmentRef,
} from '../../domain/conversation-attachment.repository.js';
import type { ConversationAttachment } from '../../domain/conversation-attachment.js';
import { ConversationAttachmentTypeormEntity } from './conversation-attachment.entity.js';
import {
  inScope,
  requireUnitOfWork,
  updatedRows,
} from './conversation-scope.js';
import {
  attachmentMutable,
  attachmentToDomain,
  attachmentToInsert,
} from './conversation.mapper.js';

const uploaderColumns = (
  u: ConversationActor,
): [string | null, string | null] =>
  u.kind === 'user' ? [u.userId, null] : [null, u.hubId];

@Injectable()
export class ConversationAttachmentTypeormRepository extends ConversationAttachmentRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async insertIfAbsent(
    scope: ConversationScope,
    a: ConversationAttachment,
  ): Promise<boolean> {
    const result = await inScope(this.dataSource, scope, (m) =>
      m
        .getRepository(ConversationAttachmentTypeormEntity)
        .createQueryBuilder()
        .insert()
        .values(attachmentToInsert(a))
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
  ): Promise<ConversationAttachment | null> {
    if (!validate(id)) return null;
    const row = await inScope(this.dataSource, scope, (m) =>
      m.getRepository(ConversationAttachmentTypeormEntity).findOne({
        where: { id, organizationId: scope.organizationId },
        withDeleted: options.withDeleted ?? false,
      }),
    );
    return row ? attachmentToDomain(row) : null;
  }

  async lockById(
    scope: ConversationScope,
    id: string,
  ): Promise<ConversationAttachment | null> {
    requireUnitOfWork(
      this.dataSource,
      'ConversationAttachmentRepository.lockById',
    );
    if (!validate(id)) return null;
    const row = await inScope(this.dataSource, scope, (m) =>
      this.lockRow(m, scope.organizationId, id),
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

  async databaseNow(): Promise<Date> {
    const rows: { now: Date }[] = await currentManager(this.dataSource).query(
      `SELECT clock_timestamp() AS now`,
    );
    return rows[0]!.now;
  }

  async markWrite(
    scope: ConversationScope,
    id: string,
    uploader: ConversationActor,
  ): Promise<Date | null> {
    if (!validate(id)) return null;
    const [userId, hubId] = uploaderColumns(uploader);
    const raw: unknown = await inScope(this.dataSource, scope, (m) =>
      m.query(
        `UPDATE conversation_attachments
            SET s3_write_started_at = GREATEST(COALESCE(s3_write_started_at, now()), now())
          WHERE organization_id = $1 AND id = $2 AND status = 'pending' AND deleted_at IS NULL
            AND uploaded_by_user_id IS NOT DISTINCT FROM $3::uuid
            AND uploaded_by_hub_id IS NOT DISTINCT FROM $4::uuid
        RETURNING s3_write_started_at AS mark`,
        [scope.organizationId, id, userId, hubId],
      ),
    );
    return updatedRows<{ mark: Date }>(raw)[0]?.mark ?? null;
  }

  async writeMark(scope: ConversationScope, id: string): Promise<Date | null> {
    const rows: { mark: Date | null }[] = await inScope(
      this.dataSource,
      scope,
      (m) =>
        m.query(
          `SELECT s3_write_started_at AS mark FROM conversation_attachments
            WHERE organization_id = $1 AND id = $2`,
          [scope.organizationId, id],
        ),
    );
    return rows[0]?.mark ?? null;
  }

  async staleWriteMarks(
    olderThanMinutes: number,
  ): Promise<MarkedAttachmentRef[]> {
    // Sem organização no contexto: só a policy conversation_attachment_reconcile_read (linhas marcadas) deixa ler.
    const rows: { organization_id: string; id: string }[] =
      await runWithContext(
        this.dataSource,
        { storageReconcile: 'on', organizationId: '', userId: '', hubId: '' },
        (m) =>
          m.query(
            `SELECT organization_id, id FROM conversation_attachments
              WHERE s3_write_started_at < now() - make_interval(mins => $1)
              ORDER BY organization_id, id`,
            [olderThanMinutes],
          ),
      );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      attachmentId: r.id,
    }));
  }

  async lockMarked(
    organizationId: string,
    id: string,
  ): Promise<ConversationAttachment | null> {
    requireUnitOfWork(
      this.dataSource,
      'ConversationAttachmentRepository.lockMarked',
    );
    const row = await this.inReconcile(organizationId, (m) =>
      this.lockRow(m, organizationId, id),
    );
    return row ? attachmentToDomain(row) : null;
  }

  async clearWriteMark(
    organizationId: string,
    id: string,
    olderThanMinutes: number,
  ): Promise<void> {
    await this.inReconcile(organizationId, (m) =>
      m.query(
        `UPDATE conversation_attachments SET s3_write_started_at = NULL
          WHERE organization_id = $1 AND id = $2
            AND s3_write_started_at < now() - make_interval(mins => $3)`,
        [organizationId, id, olderThanMinutes],
      ),
    );
  }

  private lockRow(
    m: EntityManager,
    organizationId: string,
    id: string,
  ): Promise<ConversationAttachmentTypeormEntity | null> {
    return m
      .getRepository(ConversationAttachmentTypeormEntity)
      .createQueryBuilder('a')
      .withDeleted()
      .where('a.id = :id AND a.organization_id = :org', {
        id,
        org: organizationId,
      })
      .setLock('pessimistic_write')
      .getOne();
  }

  // O contexto do reparo: a organização da linha e a chave da varredura, sem participante (as policies só abrem as
  // linhas MARCADAS; migration ConversationAttachmentStorage).
  private inReconcile<T>(
    organizationId: string,
    work: (m: EntityManager) => Promise<T>,
  ): Promise<T> {
    return runWithContext(
      this.dataSource,
      { organizationId, storageReconcile: 'on', userId: '', hubId: '' },
      work,
    );
  }
}
