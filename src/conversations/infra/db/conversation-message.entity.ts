import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
} from 'typeorm';
import { DeviceIdSyncableTypeormEntity } from './device-id.entity-base.js';
import type { ConversationTypeormEntity } from './conversation.entity.js';

// Mensagem imutável de uma conversa (id do aparelho). Apagar = lápide; o corpo cifrado fica 30 dias e depois a
// retenção o zera (a linha fica para a sincronização). Caixa de entrada: `pending` até o executor confirmar (`acked_at`).
@Entity('conversation_messages')
// Alvo das FKs compostas da edição e dos anexos: a mensagem referenciada é da mesma conversa e organização.
@Unique('uq_conversation_messages_id_conversation', [
  'id',
  'conversationId',
  'organizationId',
])
@Check(
  'ck_conversation_messages_author',
  `(num_nonnulls("author_user_id", "author_hub_id") + "author_cloud"::int) = 1`,
)
@Check('ck_conversation_messages_key_version', `"key_version" >= 1`)
@Check(
  'ck_conversation_messages_body_bytes',
  `"body_bytes" BETWEEN 1 AND 65536`,
)
@Check(
  'ck_conversation_messages_body_length',
  `("encrypted_body" IS NULL) OR ((length("encrypted_body") * 3) / 4 = "body_bytes")`,
)
@Check(
  'ck_conversation_messages_body_retention',
  `("encrypted_body" IS NOT NULL) OR ("deleted_at" IS NOT NULL)`,
)
@Check('ck_conversation_messages_pending', `"pending" = ("acked_at" IS NULL)`)
@Check(
  'ck_conversation_messages_hub_acked',
  `("author_hub_id" IS NULL) OR (NOT "pending")`,
)
@Check('ck_conversation_messages_replaces', `"replaces_message_id" <> "id"`)
@Check(
  'ck_conversation_messages_acked_by',
  `("acked_by_hub_id" IS NULL) OR (NOT "pending")`,
)
// A nuvem (executor de reserva) como autora nasce confirmada; confirmada por no máximo um (Hub ou nuvem).
@Check(
  'ck_conversation_messages_cloud_acked',
  `(NOT "author_cloud") OR (NOT "pending")`,
)
@Check(
  'ck_conversation_messages_acked_by_cloud',
  `(NOT "acked_by_cloud") OR ((NOT "pending") AND ("acked_by_hub_id" IS NULL))`,
)
@Index('ix_conversation_messages_sync_version', ['syncVersion'])
@Index('fk_conversation_messages_organizations_idx', ['organizationId'])
@Index('fk_conversation_messages_conversations_idx', ['conversationId'])
@Index('fk_conversation_messages_author_users_idx', ['authorUserId'])
@Index('fk_conversation_messages_author_hubs_idx', ['authorHubId'])
@Index('fk_conversation_messages_replaces_idx', ['replacesMessageId'])
@Index('fk_conversation_messages_acked_by_hubs_idx', ['ackedByHubId'])
@Index('ix_conversation_messages_pending', ['conversationId'], {
  where: `"pending" AND "deleted_at" IS NULL`,
})
export class ConversationMessageTypeormEntity extends DeviceIdSyncableTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_conversation_messages_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne('ConversationTypeormEntity')
  @JoinColumn([
    {
      name: 'conversation_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_messages_conversations',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_messages_conversations',
    },
  ])
  conversation?: ConversationTypeormEntity;

  @Column({ type: 'uuid', nullable: true })
  authorUserId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'author_user_id',
    foreignKeyConstraintName: 'fk_conversation_messages_author_users',
  })
  authorUser?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  authorHubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'author_hub_id',
    foreignKeyConstraintName: 'fk_conversation_messages_author_hubs',
  })
  authorHub?: { id: string };

  /** The cloud (reserve executor) wrote it (migration ConversationCloudReserve). */
  @Column({ type: 'boolean', default: false })
  authorCloud!: boolean;

  @Column({ type: 'integer' })
  keyVersion!: number;

  @Column({ type: 'text', nullable: true })
  encryptedBody!: string | null;

  @Column({ type: 'integer' })
  bodyBytes!: number;

  @Column({ type: 'uuid', nullable: true })
  replacesMessageId!: string | null;

  @ManyToOne('ConversationMessageTypeormEntity')
  @JoinColumn([
    {
      name: 'replaces_message_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_messages_replaces',
    },
    {
      name: 'conversation_id',
      referencedColumnName: 'conversationId',
      foreignKeyConstraintName: 'fk_conversation_messages_replaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_messages_replaces',
    },
  ])
  replacesMessage?: ConversationMessageTypeormEntity;

  @Column({ type: 'boolean' })
  pending!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  ackedAt!: Date | null;

  /** The executor Hub that acknowledged a person's message (migration ConversationMessageAckedBy). */
  @Column({ type: 'uuid', nullable: true })
  ackedByHubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'acked_by_hub_id',
    foreignKeyConstraintName: 'fk_conversation_messages_acked_by_hubs',
  })
  ackedByHub?: { id: string };

  /** The cloud (reserve executor) acknowledged it. */
  @Column({ type: 'boolean', default: false })
  ackedByCloud!: boolean;

  @Column({ type: 'timestamptz' })
  sentAt!: Date;
}
