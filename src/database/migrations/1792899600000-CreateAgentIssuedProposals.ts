import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  disableOrganizationRls,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

// Propostas de documento emitidas pelo passo do cérebro do agente do PC (spec pc-agent §5.3, "Ferramentas de
// documento"; correção de segurança da revisão da Task 12): quando `propose_document` roda num passo, o back guarda o
// `proposal_id` que emitiu e o SHA-256 do conteúdo canônico da proposta (`proposalContentSha256`: título, conteúdo e
// confidencialidade). Uma proposta numa mensagem do executor (`hub`) só vale para gravar se o id foi emitido por aqui
// PARA ESTE assunto e o hash bate: o agente não consegue pôr na própria mensagem uma proposta inventada ou alterada.
// - SÓ ids e o hash, nada legível.
// - Tabela própria e não colunas em `agent_brain_steps`: aquela linha é por mensagem respondida, e a proposta é conferida
//   na resposta a OUTRA mensagem (a seguinte) do mesmo assunto; aqui a chave é (assunto, proposta).
// - Só de acréscimo: o runtime fica com SELECT e INSERT (sem UPDATE, sem DELETE), como `agent_action_logs`.
// - RLS por organização (`org_isolation`). Sem FK para a conversa (RLS e retenção próprias), como `agent_brain_steps`.
export class CreateAgentIssuedProposals1792899600000 implements MigrationInterface {
  name = 'CreateAgentIssuedProposals1792899600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_issued_proposals" (
        "id" uuid NOT NULL DEFAULT uuidv7(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "proposal_id" uuid NOT NULL,
        "content_sha256" character(64) NOT NULL,
        CONSTRAINT "PK_agent_issued_proposals" PRIMARY KEY ("id"),
        CONSTRAINT "uq_agent_issued_proposals_conversation_proposal" UNIQUE ("conversation_id", "proposal_id"),
        CONSTRAINT "ck_agent_issued_proposals_sha256" CHECK ("content_sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "fk_agent_issued_proposals_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_agent_issued_proposals_organizations_idx" ON "agent_issued_proposals" ("organization_id")`,
    );
    await enableOrganizationRls(queryRunner, 'agent_issued_proposals');
    await queryRunner.query(
      `REVOKE UPDATE ON "agent_issued_proposals" FROM app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await disableOrganizationRls(queryRunner, 'agent_issued_proposals');
    await queryRunner.query(`DROP TABLE "agent_issued_proposals"`);
  }
}
