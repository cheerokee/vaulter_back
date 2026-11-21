import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';

// Uma ação auditada do agente (spec pc-agent §5.6), só de acréscimo (runtime: SELECT/INSERT; migration
// CreateAgentActionLogs). Sem coluna para argumento, resultado, caminho ou URL. `actionId` é o id do agente (idempotência
// por Hub); `id` é a chave interna, o cursor das listagens. RLS: `org_isolation` + `owner_read`.
@Entity('agent_action_logs')
@Unique('uq_agent_action_logs_hub_action', ['hubId', 'actionId'])
@Check(
  'ck_agent_action_logs_effect',
  `"effect" IN ('allow', 'confirm', 'deny')`,
)
@Check(
  'ck_agent_action_logs_decision',
  `"decision" IN ('executed', 'declined', 'blocked', 'failed')`,
)
@Check('ck_agent_action_logs_duration', `"duration_ms" >= 0`)
@Check('ck_agent_action_logs_policy_version', `"policy_version" >= 0`)
@Index('ix_agent_action_logs_organization', ['organizationId', 'id'])
@Index('ix_agent_action_logs_owner', ['ownerUserId', 'id'])
@Index('fk_agent_action_logs_hubs_idx', ['hubId', 'ownerUserId'])
export class AgentActionTypeormEntity {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'uuid' })
  actionId!: string;

  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_agent_action_logs_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  spaceId!: string;

  @Column({ type: 'uuid' })
  hubId!: string;

  @Column({ type: 'uuid' })
  ownerUserId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('HubTypeormEntity')
  @JoinColumn([
    {
      name: 'hub_id',
      referencedColumnName: 'id',
      foreignKeyConstraintName: 'fk_agent_action_logs_hubs',
    },
    {
      name: 'owner_user_id',
      referencedColumnName: 'ownerUserId',
      foreignKeyConstraintName: 'fk_agent_action_logs_hubs',
    },
  ])
  hub?: { id: string };

  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'varchar', length: 200 })
  toolName!: string;

  @Column({ type: 'varchar', length: 8 })
  effect!: string;

  @Column({ type: 'varchar', length: 8 })
  decision!: string;

  @Column({ type: 'timestamptz' })
  startedAt!: Date;

  @Column({ type: 'integer' })
  durationMs!: number;

  @Column({ type: 'integer' })
  policyVersion!: number;
}
