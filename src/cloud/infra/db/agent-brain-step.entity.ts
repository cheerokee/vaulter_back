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

// Contador do passo do cérebro do agente do PC (spec pc-agent §5.3, "Contagem dos passos"; migration
// CreateAgentBrainSteps): uma linha por mensagem respondida pelo agente, com as chamadas ao modelo e o custo. SÓ ids e
// números (nem texto, nem nome de ferramenta): o limite `BRAIN_MAX_CALLS` não depende do agente. `chunk_ids` guarda os
// ids dos trechos buscados no passo 0 (Task 11), para os passos seguintes usarem os mesmos. RLS por organização; sem
// FK para conversa e mensagem (como `agent_action_logs`: têm RLS e retenção próprias); índice da FK da organização na
// migration AgentBrainStepsOrganizationIndex. Não sincroniza.
@Entity('agent_brain_steps')
@Unique('uq_agent_brain_steps_conversation_message', [
  'conversationId',
  'messageId',
])
@Check('ck_agent_brain_steps_counts', `"calls" >= 0 AND "cost_micro_usd" >= 0`)
@Index('fk_agent_brain_steps_organizations_idx', ['organizationId'])
export class AgentBrainStepTypeormEntity extends BaseTypeormEntity {
  @Column({ type: 'uuid' })
  organizationId!: string;

  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_agent_brain_steps_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'uuid' })
  messageId!: string;

  @Column({ type: 'integer', default: 0 })
  calls!: number;

  @Column({ type: 'bigint', default: 0 })
  costMicroUsd!: string;

  @Column({ type: 'uuid', array: true, nullable: true })
  chunkIds!: string[] | null;
}
