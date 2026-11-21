import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  disableOrganizationRls,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

// Auditoria das ações do agente do PC (spec pc-agent §5.6): uma linha por ferramenta chamada, mandada em lote pelo
// agente (`POST /hub/agent/actions`). SÓ ids, o nome da ferramenta, o efeito da ACL, a decisão, a hora, a duração e a
// versão da política: nenhum argumento, resultado, caminho ou URL (nem há coluna para eles).
// - Só de acréscimo: o runtime fica com SELECT e INSERT (sem UPDATE, sem DELETE), como `audit_logs`.
// - `action_id` é o id que o agente deu à ação (idempotência: `UNIQUE (hub_id, action_id)`; por Hub, para o id de um
//   Hub nunca colidir com o de outro nem revelar que existe). `id` é a chave interna, UUID v7 do servidor, e é a
//   ordem/cursor das listagens.
// - `organization_id` e `space_id` saem da conversa (porta `HubConversationScope` do `conversations`), nunca do
//   agente; `owner_user_id` é o dono do Hub, lido pelo servidor (FK composta com `hubs (id, owner_user_id)`, como
//   `agent_tools`). `conversation_id`/`message_id` ficam sem FK de propósito: conversas e mensagens têm RLS e
//   retenção próprias, e a auditoria sobrevive a elas.
// - RLS: `org_isolation` (admin com `org.agents.manage` lê a organização) e `owner_read` (o dono lê o que o próprio
//   agente fez, em qualquer organização, só SELECT).
const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;

export class CreateAgentActionLogs1792899300000 implements MigrationInterface {
  name = 'CreateAgentActionLogs1792899300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_action_logs" (
        "id" uuid NOT NULL DEFAULT uuidv7(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "action_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "hub_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "message_id" uuid NOT NULL,
        "tool_name" character varying(200) NOT NULL,
        "effect" character varying(8) NOT NULL,
        "decision" character varying(8) NOT NULL,
        "started_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "duration_ms" integer NOT NULL,
        "policy_version" integer NOT NULL,
        CONSTRAINT "PK_agent_action_logs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_agent_action_logs_hub_action" UNIQUE ("hub_id", "action_id"),
        CONSTRAINT "ck_agent_action_logs_effect" CHECK ("effect" IN ('allow', 'confirm', 'deny')),
        CONSTRAINT "ck_agent_action_logs_decision" CHECK ("decision" IN ('executed', 'declined', 'blocked', 'failed')),
        CONSTRAINT "ck_agent_action_logs_duration" CHECK ("duration_ms" >= 0),
        CONSTRAINT "ck_agent_action_logs_policy_version" CHECK ("policy_version" >= 0),
        CONSTRAINT "fk_agent_action_logs_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_agent_action_logs_hubs" FOREIGN KEY ("hub_id", "owner_user_id") REFERENCES "hubs" ("id", "owner_user_id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_agent_action_logs_organization" ON "agent_action_logs" ("organization_id", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_agent_action_logs_owner" ON "agent_action_logs" ("owner_user_id", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_agent_action_logs_hubs_idx" ON "agent_action_logs" ("hub_id", "owner_user_id")`,
    );
    await enableOrganizationRls(queryRunner, 'agent_action_logs');
    await queryRunner.query(
      `CREATE POLICY "owner_read" ON "agent_action_logs" FOR SELECT USING (owner_user_id = ${USER})`,
    );
    await queryRunner.query(
      `REVOKE UPDATE ON "agent_action_logs" FROM app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY "owner_read" ON "agent_action_logs"`);
    await disableOrganizationRls(queryRunner, 'agent_action_logs');
    await queryRunner.query(`DROP TABLE "agent_action_logs"`);
  }
}
