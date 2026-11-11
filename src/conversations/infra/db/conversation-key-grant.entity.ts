import { Check, Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { ConversationTypeormEntity } from './conversation.entity.js';

// Cópia trancada de uma versão da chave da conversa, para exatamente uma pessoa, o Hub executor OU a chave do servidor
// (nuvem de reserva; nunca o kit da organização: privado é privado). Tirar = lápide; quem volta tem a lápide limpa na
// mesma linha. A cópia do servidor é apagada de verdade (migration ConversationCloudReserve).
@Entity('conversation_key_grants')
@Check(
  'ck_conversation_key_grants_recipient',
  `(num_nonnulls("user_id", "hub_id") + "server_recipient"::int) = 1`,
)
@Check('ck_conversation_key_grants_key_version', `"key_version" >= 1`)
@Check(
  'ck_conversation_key_grants_wrapped_key',
  `"wrapped_key" ~ '^[A-Za-z0-9_-]{108}$'`,
)
@Index('ix_conversation_key_grants_sync_version', ['syncVersion'])
@Index(
  'uq_conversation_key_grants_user',
  ['conversationId', 'keyVersion', 'userId'],
  {
    unique: true,
    where: '"user_id" IS NOT NULL AND "deleted_at" IS NULL',
  },
)
@Index(
  'uq_conversation_key_grants_hub',
  ['conversationId', 'keyVersion', 'hubId'],
  {
    unique: true,
    where: '"hub_id" IS NOT NULL AND "deleted_at" IS NULL',
  },
)
@Index('uq_conversation_key_grants_server', ['conversationId', 'keyVersion'], {
  unique: true,
  where: '"server_recipient" AND "deleted_at" IS NULL',
})
@Index('fk_conversation_key_grants_organizations_idx', ['organizationId'])
@Index('fk_conversation_key_grants_conversations_idx', ['conversationId'])
@Index('fk_conversation_key_grants_users_idx', ['userId'])
@Index('fk_conversation_key_grants_hubs_idx', ['hubId'])
export class ConversationKeyGrantTypeormEntity extends SyncableTypeormEntity {
  // Provisória até o COMMIT dar a versão (trigger; migration ConversationFeedCommitOrder).
  @Column({
    type: 'boolean',
    default: true,
    insert: false,
    update: false,
    select: false,
  })
  syncPending!: boolean;

  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_conversation_key_grants_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne('ConversationTypeormEntity')
  @JoinColumn([
    {
      name: 'conversation_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_key_grants_conversations',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_key_grants_conversations',
    },
  ])
  conversation?: ConversationTypeormEntity;

  @Column({ type: 'integer' })
  keyVersion!: number;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_conversation_key_grants_users',
  })
  user?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  hubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'hub_id',
    foreignKeyConstraintName: 'fk_conversation_key_grants_hubs',
  })
  hub?: { id: string };

  @Column({ type: 'boolean', default: false })
  serverRecipient!: boolean;

  @Column({ type: 'varchar', length: 108 })
  wrappedKey!: string;
}
