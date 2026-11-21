import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addCommitOrderedSyncVersion,
  addSyncVersionTrigger,
  COMMIT_ORDERED_SYNC_FEED,
  dropCommitOrderedSyncVersion,
  dropSyncVersionTrigger,
  enableOrganizationRls,
  disableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

// Política de IA da organização para o agente do PC (spec pc-agent §5.5): uma linha por versão, só de acréscimo (a
// atual é a maior; `UNIQUE (organization_id, version)` é também a trava final contra duas versões iguais). Mudar =
// versão nova inteira, com `base_version` conferida sob a trava da organização (`lockForAgentPolicy`). As regras são
// configuração do admin, não conteúdo de cliente: ficam legíveis, validadas por `parseAgentRules` antes de gravar.
// - RLS por organização (`org_isolation`). Os default privileges dão UPDATE ao runtime: aqui ele fica só com SELECT e
//   INSERT, como `audit_logs`, mais o UPDATE das duas colunas de versão que o COMMIT precisa.
// - Versão no COMMIT, na ordem dos commits, no MESMO feed da sincronização do Hub (`COMMIT_ORDERED_SYNC_FEED`): o Hub
//   `pc` recebe o item `agent_policy` `{ organizationId, version }` (nunca as regras) e baixa a política pela rota
//   `GET /hub/agent/policy`. A tabela nova entra na lista de tabelas do leitor da sincronização.
export class CreateAgentPolicies1792899200000 implements MigrationInterface {
  name = 'CreateAgentPolicies1792899200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "agent_policies" (
        "id" uuid NOT NULL DEFAULT uuidv7(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "organization_id" uuid NOT NULL,
        "version" integer NOT NULL,
        "rules" jsonb NOT NULL,
        "changed_by_user_id" uuid NOT NULL,
        CONSTRAINT "PK_agent_policies" PRIMARY KEY ("id"),
        CONSTRAINT "uq_agent_policies_organization_version" UNIQUE ("organization_id", "version"),
        CONSTRAINT "ck_agent_policies_version" CHECK ("version" >= 1),
        CONSTRAINT "fk_agent_policies_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_agent_policies_users" FOREIGN KEY ("changed_by_user_id") REFERENCES "users" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_agent_policies_users_idx" ON "agent_policies" ("changed_by_user_id")`,
    );
    await enableOrganizationRls(queryRunner, 'agent_policies');
    await addSyncVersionTrigger(queryRunner, 'agent_policies');
    await addCommitOrderedSyncVersion(
      queryRunner,
      'agent_policies',
      COMMIT_ORDERED_SYNC_FEED,
    );
    await queryRunner.query(
      `REVOKE UPDATE ON "agent_policies" FROM app_runtime`,
    );
    await queryRunner.query(
      `GRANT UPDATE ("sync_version", "sync_pending") ON "agent_policies" TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await dropCommitOrderedSyncVersion(queryRunner, 'agent_policies');
    await dropSyncVersionTrigger(queryRunner, 'agent_policies');
    await disableOrganizationRls(queryRunner, 'agent_policies');
    await queryRunner.query(`DROP TABLE "agent_policies"`);
  }
}
