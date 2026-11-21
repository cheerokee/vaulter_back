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

// Uma proposta de documento emitida pelo passo do cérebro do agente (migration CreateAgentIssuedProposals): o id e o
// SHA-256 do conteúdo canônico, nada legível. Só de acréscimo (runtime: SELECT/INSERT). RLS por organização; sem FK para
// a conversa. Não sincroniza.
@Entity('agent_issued_proposals')
@Unique('uq_agent_issued_proposals_conversation_proposal', [
  'conversationId',
  'proposalId',
])
@Check(
  'ck_agent_issued_proposals_sha256',
  `"content_sha256" ~ '^[0-9a-f]{64}$'`,
)
@Index('fk_agent_issued_proposals_organizations_idx', ['organizationId'])
export class AgentIssuedProposalTypeormEntity {
  @PrimaryColumn('uuid', { default: () => 'uuidv7()' })
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'uuid' })
  organizationId!: string;

  // Alvo por nome: um módulo não importa a infra/ do outro.
  @ManyToOne('OrganizationTypeormEntity')
  @JoinColumn({
    name: 'organization_id',
    foreignKeyConstraintName: 'fk_agent_issued_proposals_organizations',
  })
  organization?: { id: string };

  @Column({ type: 'uuid' })
  conversationId!: string;

  @Column({ type: 'uuid' })
  proposalId!: string;

  @Column({ type: 'character', length: 64 })
  contentSha256!: string;
}
