import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
} from 'typeorm';
import type { ConversationState } from '../../domain/conversation-state.js';
import { DeviceIdSyncableTypeormEntity } from './device-id.entity-base.js';

// Conversa (assunto) de um espaço. RLS: organização E (participante vivo em `participant_user_ids` OU executor);
// matriz e triggers na migration CreateConversations. Só metadado: o título e o plano vivem em `encrypted_header`.
@Entity('conversations')
// Alvo das FKs compostas (filho, organization_id).
@Unique('uq_conversations_id_organization', ['id', 'organizationId'])
@Check(
  'ck_conversations_state',
  `"state" IN ('aviso', 'trabalhando', 'na_fila', 'pede_sim', 'esperando_pc', 'concluido', 'arquivado')`,
)
@Check('ck_conversations_current_key_version', `"current_key_version" >= 1`)
@Check(
  'ck_conversations_header',
  `("encrypted_header" IS NULL) = ("header_key_version" IS NULL)`,
)
@Check(
  'ck_conversations_header_key_version',
  `"header_key_version" >= 1 AND "header_key_version" <= "current_key_version"`,
)
@Check('ck_conversations_header_length', `length("encrypted_header") <= 21846`)
// Cabeçalho nulo só com lápide (retenção; migration ConversationsHardening).
@Check(
  'ck_conversations_header_retention',
  `("encrypted_header" IS NOT NULL) OR ("deleted_at" IS NOT NULL)`,
)
@Check('ck_conversations_moved_from', `"moved_from_conversation_id" <> "id"`)
@Index('ix_conversations_sync_version', ['syncVersion'])
@Index('fk_conversations_organizations_idx', ['organizationId'])
@Index('fk_conversations_spaces_idx', ['spaceId'])
@Index('fk_conversations_created_by_idx', ['createdByUserId'])
@Index('fk_conversations_owner_idx', ['ownerUserId'])
@Index('fk_conversations_executor_hub_idx', ['executorHubId'])
export class ConversationTypeormEntity extends DeviceIdSyncableTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_conversations_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('SpaceTypeormEntity')
  @JoinColumn([
    {
      name: 'space_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_conversations_spaces',
    },
    {
      name: 'organization_id',
      referencedColumnName: 'organizationId',
      foreignKeyConstraintName: 'fk_conversations_spaces',
    },
  ])
  space?: { id: string };

  @Column({ type: 'uuid' })
  createdByUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'fk_conversations_created_by',
  })
  createdBy?: { id: string };

  @Column({ type: 'uuid' })
  ownerUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'owner_user_id',
    foreignKeyConstraintName: 'fk_conversations_owner',
  })
  owner?: { id: string };

  @Column({ type: 'uuid', nullable: true })
  executorHubId!: string | null;

  @ManyToOne('HubTypeormEntity')
  @JoinColumn({
    name: 'executor_hub_id',
    foreignKeyConstraintName: 'fk_conversations_executor_hub',
  })
  executorHub?: { id: string };

  @Column({ type: 'varchar', length: 20 })
  state!: ConversationState;

  @Column({ type: 'timestamptz', nullable: true })
  lastMessageAt!: Date | null;

  @Column({ type: 'integer', default: 1 })
  currentKeyVersion!: number;

  @Column({ type: 'boolean', default: false })
  keyRotationRequired!: boolean;

  @Column({ type: 'text', nullable: true })
  encryptedHeader!: string | null;

  @Column({ type: 'integer', nullable: true })
  headerKeyVersion!: number | null;

  // Link por id (pode ser de outra organização): sem FK.
  @Column({ type: 'uuid', nullable: true })
  movedFromConversationId!: string | null;

  // Derivado das participações vivas pelo trigger (o RLS lê daqui); nunca gravado pela aplicação.
  @Column({ type: 'uuid', array: true, insert: false, update: false })
  participantUserIds!: string[];
}
