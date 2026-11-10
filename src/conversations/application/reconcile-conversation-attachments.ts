import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { StorageReconcileHooks } from '../../shared/application/storage-reconcile-hooks.js';
import { ConversationAttachmentRepository } from '../domain/conversation-attachment.repository.js';
import { ConversationAttachmentHealer } from './attachment-healer.js';

const HOOK_NAME = 'conversations.attachments';

// A varredura do reparo dos anexos, dentro do `npm run storage:reconcile` (gancho `StorageReconcileHooks`, sem o
// `storage` importar `conversations`): todo anexo com marca de gravação no S3 mais antiga que a idade pedida (relógio
// do banco) é reparado sob a trava da linha e só então a marca (se ainda for antiga) é limpa.
@Injectable()
export class ReconcileConversationAttachments
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly hooks: StorageReconcileHooks,
    private readonly attachments: ConversationAttachmentRepository,
    private readonly healer: ConversationAttachmentHealer,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      reconcile: (age) => this.execute(age),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async execute(
    olderThanMinutes: number,
  ): Promise<{ attachments: number; removedVersions: number }> {
    const refs = await this.attachments.staleWriteMarks(olderThanMinutes);
    return {
      attachments: refs.length,
      removedVersions: await this.healer.repair(refs, olderThanMinutes),
    };
  }
}
