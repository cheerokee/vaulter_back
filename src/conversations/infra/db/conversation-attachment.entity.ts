import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import type { AttachmentStatus } from '../../domain/conversation-attachment.js';
import { DeviceIdSyncableTypeormEntity } from './device-id.entity-base.js';
import type { ConversationMessageTypeormEntity } from './conversation-message.entity.js';
import type { ConversationTypeormEntity } from './conversation.entity.js';

// Índice dos anexos cifrados de uma conversa (id do aparelho; objeto no S3 em
// orgs/<orgId>/spaces/<spaceId>/conversations/<conversationId>/<attachmentId>). Só ids, tamanho, sha256 do blob
// cifrado, versão da chave e datas: nunca nome ou tipo. Mesmo diário de gravações no S3 do índice do backup.
@Entity('conversation_attachments')
@Check(
  'ck_conversation_attachments_status',
  `"status" IN ('pending', 'committed', 'purged')`,
)
@Check(
  'ck_conversation_attachments_size_bytes',
  `"size_bytes" BETWEEN 1 AND 104857600`,
)
@Check('ck_conversation_attachments_key_version', `"key_version" >= 1`)
@Check('ck_conversation_attachments_sha256', `"sha256" ~ '^[0-9a-f]{64}$'`)
@Check(
  'ck_conversation_attachments_committed',
  `("status" IN ('committed', 'purged')) = ("s3_version_id" IS NOT NULL)`,
)
@Check(
  'ck_conversation_attachments_uploader',
  `num_nonnulls("uploaded_by_user_id", "uploaded_by_hub_id") = 1`,
)
@Index('ix_conversation_attachments_sync_version', ['syncVersion'])
@Index('fk_conversation_attachments_spaces_idx', ['spaceId'])
@Index('fk_conversation_attachments_uploaded_by_users_idx', [
  'uploadedByUserId',
])
@Index('fk_conversation_attachments_uploaded_by_hubs_idx', ['uploadedByHubId'])
@Index('fk_conversation_attachments_organizations_idx', ['organizationId'])
@Index('fk_conversation_attachments_conversations_idx', ['conversationId'])
@Index('fk_conversation_attachments_messages_idx', ['messageId'])
@Index('ix_conversation_attachments_s3_write_started', ['s3WriteStartedAt'], {
  where: `"s3_write_started_at" IS NOT NULL`,
})
export class ConversationAttachmentTypeormEntity extends DeviceIdSyncableTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_conversation_attachments_organizations',
  })
  organization?: { id: string };

  // O espaço da conversa (parte da chave no S3): o trigger trg_conversation_attachments_space confere (ou preenche) a
  // partir da conversa no INSERT, e nunca muda. Fica na linha para a varredura do reparo achar a chave sem ver a conversa.
  @Column({ type: 'uuid' })
  spaceId!: string;

  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_attachments_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_attachments_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne('ConversationTypeormEntity')
  @JoinColumn([
    {
      name: 'conversation_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_attachments_conversations',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_attachments_conversations',
    },
  ])
  conversation?: ConversationTypeormEntity;

  @Column({ type: 'uuid', nullable: true })
  messageId!: string | null;

  @ManyToOne('ConversationMessageTypeormEntity')
  @JoinColumn([
    {
      name: 'message_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_attachments_messages',
    },
    {
      name: 'conversation_id',
      referencedColumnName: 'conversationId',
      foreignKeyConstraintName: 'fk_conversation_attachments_messages',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_attachments_messages',
    },
  ])
  message?: ConversationMessageTypeormEntity;

  // Quem pediu o envio (pessoa ou Hub executor): só ele confirma.
  @Column({ type: 'uuid', nullable: true })
  uploadedByUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'uploaded_by_user_id',
    foreignKeyConstraintName: 'fk_conversation_attachments_uploaded_by_users',
  })
  uploadedByUser?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  uploadedByHubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'uploaded_by_hub_id',
    foreignKeyConstraintName: 'fk_conversation_attachments_uploaded_by_hubs',
  })
  uploadedByHub?: { id: string };

  @Column({ type: 'integer' })
  keyVersion!: number;

  // bigint volta como string no driver pg (o mapper converte com byteCount).
  @Column({ type: 'bigint' })
  sizeBytes!: string;

  @Column({ type: 'char', length: 64 })
  sha256!: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: AttachmentStatus;

  // Id de versão do S3 (até 1024 bytes pela documentação da AWS).
  @Column({ type: 'varchar', length: 1024, nullable: true })
  s3VersionId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  s3WriteStartedAt!: Date | null;

  @Column({ type: 'timestamptz' })
  uploadExpiresAt!: Date;
}
