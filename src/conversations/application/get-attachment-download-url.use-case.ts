import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { PRESIGNED_URL_TTL_SECONDS } from '../../storage/application/object-uploads.js';
import { ObjectStore } from '../../storage/application/ports/object-store.js';
import { attachmentKey } from '../domain/attachment-keys.js';
import { ConversationAttachmentRepository } from '../domain/conversation-attachment.repository.js';
import { attachmentNotFound } from '../domain/conversation-errors.js';
import type { ScopedConversation } from './conversation-access.js';
import { ConversationAccess } from './conversation-access.js';

export type AttachmentDownloadUrl = { url: string; expiresAt: Date };

// URL assinada de GET de um anexo confirmado (spec conversations §4.4), para participante (token de usuário) ou o
// executor (token de Hub); o resto, o mesmo 404 `conversation-not-found`. Sem trava e sem unit of work. A versão do S3
// vem SEMPRE do índice (`s3_version_id`), nunca da versão "atual" do bucket. Pendente, apagado, `purged`, de outro
// assunto ou inexistente: 404 `attachment-not-found`. Vale 15 min e não é revogável (quem sai guarda só a URL que já
// tinha, e o conteúdo é cifrado com a chave que ele já conhecia).
@Injectable()
export class GetAttachmentDownloadUrlUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly attachments: ConversationAttachmentRepository,
    private readonly store: ObjectStore,
  ) {}

  async byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentDownloadUrl> {
    return this.sign(
      await this.access.findForUser(spaceId, conversationId, actor.userId),
      attachmentId,
    );
  }

  async byHub(
    hub: HubAuthContext,
    conversationId: string,
    attachmentId: string,
  ): Promise<AttachmentDownloadUrl> {
    return this.sign(
      await this.access.findForHub(hub.hubId, conversationId),
      attachmentId,
    );
  }

  private async sign(
    { scope, conversation }: ScopedConversation,
    attachmentId: string,
  ): Promise<AttachmentDownloadUrl> {
    const a = await this.attachments.findById(scope, attachmentId);
    if (
      !a ||
      a.conversationId !== conversation.id ||
      a.status !== 'committed' ||
      a.deletedAt ||
      !a.s3VersionId
    ) {
      throw attachmentNotFound();
    }
    const expiresAt = new Date(Date.now() + PRESIGNED_URL_TTL_SECONDS * 1000);
    const url = await this.store.presignGet(
      attachmentKey(a),
      a.s3VersionId,
      PRESIGNED_URL_TTL_SECONDS,
    );
    return { url, expiresAt };
  }
}
