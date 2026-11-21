import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  disableOrganizationRls,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

// Contador do passo do cérebro do agente do PC (spec pc-agent §5.3, "Contagem dos passos"): uma linha por mensagem
// (`UNIQUE (conversation_id, message_id)`), com as chamadas ao modelo (`calls`, limite `BRAIN_MAX_CALLS` = 16 conferido
// no `INSERT ... ON CONFLICT DO UPDATE ... WHERE calls < 16`), o custo acertado (`cost_micro_usd`) e os ids dos trechos
// do passo 0 (`chunk_ids`). SÓ ids e números, nada legível.
// - RLS por organização (`org_isolation`); o runtime fica com SELECT/INSERT/UPDATE (sem DELETE), o padrão.
// - Sem FK para conversa e mensagem, como `agent_action_logs`: têm RLS e retenção próprias.
export class CreateAgentBrainSteps1792899500000 implements MigrationInterface {
  name = 'CreateAgentBrainSteps1792899500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_brain_steps" (
        "id" uuid NOT NULL DEFAULT uuidv7(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "organization_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "message_id" uuid NOT NULL,
        "calls" integer NOT NULL DEFAULT '0',
        "cost_micro_usd" bigint NOT NULL DEFAULT '0',
        "chunk_ids" uuid array,
        CONSTRAINT "PK_agent_brain_steps" PRIMARY KEY ("id"),
        CONSTRAINT "uq_agent_brain_steps_conversation_message" UNIQUE ("conversation_id", "message_id"),
        CONSTRAINT "ck_agent_brain_steps_counts" CHECK ("calls" >= 0 AND "cost_micro_usd" >= 0),
        CONSTRAINT "fk_agent_brain_steps_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
      )
    `);
    await enableOrganizationRls(queryRunner, 'agent_brain_steps');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await disableOrganizationRls(queryRunner, 'agent_brain_steps');
    await queryRunner.query(`DROP TABLE "agent_brain_steps"`);
  }
}
