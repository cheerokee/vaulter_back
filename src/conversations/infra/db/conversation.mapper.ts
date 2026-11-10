import { byteCount } from '../../../shared/infra/db/byte-count.js';
import { ConversationAttachment } from '../../domain/conversation-attachment.js';
import { ConversationMessage } from '../../domain/conversation-message.js';
import { Conversation } from '../../domain/conversation.js';
import type { ConversationAttachmentTypeormEntity } from './conversation-attachment.entity.js';
import type { ConversationMessageTypeormEntity } from './conversation-message.entity.js';
import type { ConversationTypeormEntity } from './conversation.entity.js';

export function conversationToDomain(
  e: ConversationTypeormEntity,
): Conversation {
  return Conversation.restore(
    {
      organizationId: e.organizationId,
      spaceId: e.spaceId,
      createdByUserId: e.createdByUserId,
      ownerUserId: e.ownerUserId,
      executorHubId: e.executorHubId,
      state: e.state,
      lastMessageAt: e.lastMessageAt,
      currentKeyVersion: e.currentKeyVersion,
      keyRotationRequired: e.keyRotationRequired,
      encryptedHeader: e.encryptedHeader,
      headerKeyVersion: e.headerKeyVersion,
      movedFromConversationId: e.movedFromConversationId,
      participantUserIds: e.participantUserIds,
      createdAt: e.createdAt,
      updatedAt: e.updatedAt,
      deletedAt: e.deletedAt,
    },
    e.id,
  );
}

// Campos que a aplicação grava ao criar (participant_user_ids e sync_version vêm dos triggers).
export function conversationToInsert(
  c: Conversation,
): Partial<ConversationTypeormEntity> {
  return {
    id: c.id,
    organizationId: c.organizationId,
    spaceId: c.spaceId,
    createdByUserId: c.createdByUserId,
    ...conversationMutable(c),
    movedFromConversationId: c.movedFromConversationId,
    ...(c.createdAt ? { createdAt: c.createdAt } : {}),
  };
}

// O que muda depois de criar. Nunca os participantes (derivados) nem espaço/criador/origem.
export function conversationMutable(
  c: Conversation,
): Partial<ConversationTypeormEntity> {
  return {
    ownerUserId: c.ownerUserId,
    executorHubId: c.executorHubId,
    state: c.state,
    lastMessageAt: c.lastMessageAt,
    currentKeyVersion: c.currentKeyVersion,
    keyRotationRequired: c.keyRotationRequired,
    encryptedHeader: c.encryptedHeader,
    headerKeyVersion: c.headerKeyVersion,
    deletedAt: c.deletedAt,
  };
}

export function messageToDomain(
  e: ConversationMessageTypeormEntity,
): ConversationMessage {
  return ConversationMessage.restore(
    {
      organizationId: e.organizationId,
      conversationId: e.conversationId,
      authorUserId: e.authorUserId,
      authorHubId: e.authorHubId,
      keyVersion: e.keyVersion,
      encryptedBody: e.encryptedBody,
      bodyBytes: e.bodyBytes,
      replacesMessageId: e.replacesMessageId,
      pending: e.pending,
      ackedAt: e.ackedAt,
      sentAt: e.sentAt,
      createdAt: e.createdAt,
      deletedAt: e.deletedAt,
    },
    e.id,
  );
}

export function messageToInsert(
  m: ConversationMessage,
): Partial<ConversationMessageTypeormEntity> {
  return {
    id: m.id,
    organizationId: m.organizationId,
    conversationId: m.conversationId,
    authorUserId: m.authorUserId,
    authorHubId: m.authorHubId,
    keyVersion: m.keyVersion,
    encryptedBody: m.encryptedBody,
    bodyBytes: m.bodyBytes,
    replacesMessageId: m.replacesMessageId,
    pending: m.pending,
    ackedAt: m.ackedAt,
    sentAt: m.sentAt,
    ...(m.createdAt ? { createdAt: m.createdAt } : {}),
  };
}

export function attachmentToDomain(
  e: ConversationAttachmentTypeormEntity,
): ConversationAttachment {
  return ConversationAttachment.restore(
    {
      organizationId: e.organizationId,
      spaceId: e.spaceId,
      conversationId: e.conversationId,
      uploader: e.uploadedByHubId
        ? { kind: 'hub', hubId: e.uploadedByHubId }
        : { kind: 'user', userId: e.uploadedByUserId! },
      messageId: e.messageId,
      keyVersion: e.keyVersion,
      sizeBytes: byteCount(e.sizeBytes),
      sha256: e.sha256,
      status: e.status,
      s3VersionId: e.s3VersionId,
      s3WriteStartedAt: e.s3WriteStartedAt,
      uploadExpiresAt: e.uploadExpiresAt,
      createdAt: e.createdAt,
      deletedAt: e.deletedAt,
    },
    e.id,
  );
}

export function attachmentToInsert(
  a: ConversationAttachment,
): Partial<ConversationAttachmentTypeormEntity> {
  return {
    id: a.id,
    organizationId: a.organizationId,
    spaceId: a.spaceId,
    conversationId: a.conversationId,
    uploadedByUserId: a.uploader.kind === 'user' ? a.uploader.userId : null,
    uploadedByHubId: a.uploader.kind === 'hub' ? a.uploader.hubId : null,
    keyVersion: a.keyVersion,
    sizeBytes: String(a.sizeBytes),
    sha256: a.sha256,
    ...attachmentMutable(a),
  };
}

// Nunca a marca do diário (`s3_write_started_at`): ela só muda pelo relógio do banco, em `markWrite` (renova) e
// `clearWriteMark` (só a varredura); gravar o valor lido poderia apagar uma renovação mais nova.
export function attachmentMutable(
  a: ConversationAttachment,
): Partial<ConversationAttachmentTypeormEntity> {
  return {
    messageId: a.messageId,
    status: a.status,
    s3VersionId: a.s3VersionId,
    uploadExpiresAt: a.uploadExpiresAt,
    deletedAt: a.deletedAt,
  };
}
