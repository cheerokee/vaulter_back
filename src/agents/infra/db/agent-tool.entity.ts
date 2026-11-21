import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  Unique,
} from 'typeorm';
import { BaseTypeormEntity } from '../../../shared/infra/db/base.entity.js';
import type { AgentToolCategory } from '../../domain/agent-tool.js';

// Ferramenta publicada pelo agente (Hub `pc`); lápide quando sai da lista. Sem organization_id nem sync_version.
// `ownerUserId` é a cópia do dono para a policy (migration CreateAgentTools): FK composta com `hubs (id, owner_user_id)`.
// RLS: o dono do Hub ou o próprio Hub.
@Entity('agent_tools')
@Unique('uq_agent_tools_hub_name', ['hubId', 'name'])
@Index('fk_agent_tools_hubs_idx', ['hubId', 'ownerUserId'])
@Check('ck_agent_tools_category', `"category" IN ('mcp', 'browser', 'folder')`)
export class AgentToolTypeormEntity extends BaseTypeormEntity {
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
      foreignKeyConstraintName: 'fk_agent_tools_hubs',
    },
    {
      name: 'owner_user_id',
      referencedColumnName: 'ownerUserId',
      foreignKeyConstraintName: 'fk_agent_tools_hubs',
    },
  ])
  hub?: { id: string };

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'jsonb' })
  inputSchema!: Record<string, unknown>;

  @Column({ type: 'varchar', length: 16 })
  category!: AgentToolCategory;
}
