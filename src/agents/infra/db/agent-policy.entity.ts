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
import type { AgentRule } from '../../domain/agent-policy.js';

// Uma linha por versão da política de IA da organização (spec pc-agent §5.5), só de acréscimo: o runtime tem
// SELECT/INSERT (e UPDATE só de `sync_version`/`sync_pending`, o do COMMIT; migration CreateAgentPolicies). A atual é a
// maior versão. Regras validadas por `parseAgentRules`. RLS por organização. A sincronização do Hub só leva
// `{ organizationId, version }` (item `agent_policy`), nunca as regras.
@Entity('agent_policies')
@Check('ck_agent_policies_version', `"version" >= 1`)
@Unique('uq_agent_policies_organization_version', ['organizationId', 'version'])
@Index('ix_agent_policies_sync_version', ['syncVersion'])
@Index('fk_agent_policies_users_idx', ['changedByUserId'])
export class AgentPolicyTypeormEntity {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_agent_policies_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'integer' })
  version!: number;

  @Column({ type: 'jsonb' })
  rules!: AgentRule[];

  @Column({ type: 'uuid' })
  changedByUserId!: string;

  @ManyToOne('UserTypeormEntity')
  @JoinColumn({
    name: 'changed_by_user_id',
    foreignKeyConstraintName: 'fk_agent_policies_users',
  })
  changedBy?: { id: string };

  @Column({ type: 'bigint', insert: false, update: false })
  syncVersion!: string;

  // Provisória até o COMMIT dar a versão (migration HubSyncCommitOrder); só o banco grava.
  @Column({
    type: 'boolean',
    default: true,
    insert: false,
    update: false,
    select: false,
  })
  syncPending!: boolean;
}
