import { Column, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { SyncableTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { ConversationTypeormEntity } from './conversation.entity.js';

// Participação de uma pessoa numa conversa. Sair = lápide; quem volta reaproveita a linha (limpa a lápide). Toda
// mudança recalcula `conversations.participant_user_ids` (trigger conversation_participants_sync).
@Entity('conversation_participants')
@Index('ix_conversation_participants_sync_version', ['syncVersion'])
@Index('uq_conversation_participants_live', ['conversationId', 'userId'], {
  unique: true,
  where: '"deleted_at" IS NULL',
})
@Index('fk_conversation_participants_organizations_idx', ['organizationId'])
@Index('fk_conversation_participants_conversations_idx', ['conversationId'])
@Index('fk_conversation_participants_users_idx', ['userId'])
export class ConversationParticipantTypeormEntity extends SyncableTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_conversation_participants_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  conversationId!: string;

  @ManyToOne('ConversationTypeormEntity')
  @JoinColumn([
    {
      name: 'conversation_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversation_participants_conversations',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversation_participants_conversations',
    },
  ])
  conversation?: ConversationTypeormEntity;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'fk_conversation_participants_users',
  })
  user?: { id: string };

  @Column({ type: 'timestamptz' })
  joinedAt!: Date;
}
