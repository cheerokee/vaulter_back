import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { removeUnreferencedVersions } from '../../storage/application/object-uploads.js';
import { ObjectStore } from '../../storage/application/ports/object-store.js';
import { attachmentKey } from '../domain/attachment-keys.js';
import type { ConversationAttachment } from '../domain/conversation-attachment.js';
import {
  ConversationAttachmentRepository,
  type MarkedAttachmentRef,
} from '../domain/conversation-attachment.repository.js';

// Reparo de um anexo contra o bucket (o índice é a verdade; mesma regra do `BackupObjectHealer` do storage, pela peça
// compartilhada `removeUnreferencedVersions`). A chave final de um anexo só tem UMA versão legítima: a `s3VersionId` de
// um anexo `committed` (com ou sem lápide: a lixeira dura 30 dias). Pendente ou `purged`: nenhuma. Tudo o mais (cópia de
// uma tentativa que caiu antes do COMMIT) sai do bucket. Nenhum delete marker é legítimo (anexo nunca leva um).
// Com a linha TRAVADA (`FOR UPDATE`): toda gravação no S3 de um anexo acontece sob essa trava.
@Injectable()
export class ConversationAttachmentHealer {
  private readonly logger = new Logger(ConversationAttachmentHealer.name);

  constructor(
    private readonly attachments: ConversationAttachmentRepository,
    private readonly store: ObjectStore,
    private readonly uow: UnitOfWork,
  ) {}

  /** MUST run with the attachment row locked. Returns how many S3 versions were removed. */
  async heal(a: ConversationAttachment): Promise<number> {
    const referenced = new Set<string>(
      a.status === 'committed' && a.s3VersionId ? [a.s3VersionId] : [],
    );
    const removed = await removeUnreferencedVersions(
      this.store,
      attachmentKey(a),
      referenced,
      { keepDeleteMarkers: false },
    );
    if (removed > 0) {
      this.logger.warn(
        { organizationId: a.organizationId, attachmentId: a.id, removed },
        'removed S3 versions the attachment index does not reference',
      );
    }
    return removed;
  }

  /**
   * Repairs each MARKED attachment in its own unit of work, in the reconcile context (no participant needed: the actor
   * of a failed request may have just left). Marks are cleared only when `clearMarksOlderThanMinutes` is given (the
   * sweep), after the repair. Never throws: a failure is logged and the mark stays. Returns the removed S3 versions.
   */
  async repair(
    refs: readonly MarkedAttachmentRef[],
    clearMarksOlderThanMinutes?: number,
  ): Promise<number> {
    let removed = 0;
    for (const ref of refs) {
      try {
        removed += await this.uow.run(async () => {
          const a = await this.attachments.lockMarked(
            ref.organizationId,
            ref.attachmentId,
          );
          if (!a) return 0;
          const n = await this.heal(a);
          if (clearMarksOlderThanMinutes !== undefined) {
            await this.attachments.clearWriteMark(
              ref.organizationId,
              ref.attachmentId,
              clearMarksOlderThanMinutes,
            );
          }
          return n;
        });
      } catch (error) {
        this.logger.error(
          { err: error, ...ref },
          'could not repair a conversation attachment; its write mark stays for the next sweep',
        );
      }
    }
    return removed;
  }
}
