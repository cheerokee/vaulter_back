import { MigrationInterface, QueryRunner } from 'typeorm';

// Agente do PC (spec pc-agent): permissão `org.agents.manage` (escopo organização, no `org_admin`) e o tipo `agent` no
// livro de orçamento de IA (`cloud_ai_reservations` / `cloud_ai_usage`). O catálogo RBAC é imutável por migration:
// esta é a mudança. Id fixo (UUID v7); o e2e confere banco == rbac-catalog.ts.
const PERMISSION_ID = '01a1fef8-a35b-7305-8d9f-5c289cdf425b';
const KEY = 'org.agents.manage';

export class AgentsPermissionAndUsageKind1792899000000 implements MigrationInterface {
  name = 'AgentsPermissionAndUsageKind1792899000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "permissions" ("id", "key", "scope_type", "name", "description") VALUES ($1, $2, 'organization', $3, $4)`,
      [
        PERMISSION_ID,
        KEY,
        'Gerenciar agentes',
        'Pode gerenciar os agentes (PCs) da organização e as políticas deles.',
      ],
    );
    await queryRunner.query(
      `INSERT INTO "role_permission" ("role_id", "permission_id")
       SELECT "id", $1 FROM "roles"
        WHERE "key" = 'org_admin' AND "organization_id" IS NULL AND "deleted_at" IS NULL`,
      [PERMISSION_ID],
    );
    await this.swapKindChecks(queryRunner, `('answer', 'indexing', 'agent')`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "cloud_ai_usage" WHERE "kind" = 'agent'`,
    );
    await queryRunner.query(
      `DELETE FROM "cloud_ai_reservations" WHERE "kind" = 'agent'`,
    );
    await this.swapKindChecks(queryRunner, `('answer', 'indexing')`);
    await queryRunner.query(
      `DELETE FROM "role_permission" WHERE "permission_id" = $1`,
      [PERMISSION_ID],
    );
    await queryRunner.query(`DELETE FROM "permissions" WHERE "id" = $1`, [
      PERMISSION_ID,
    ]);
  }

  private async swapKindChecks(
    queryRunner: QueryRunner,
    kinds: string,
  ): Promise<void> {
    for (const [table, name] of [
      ['cloud_ai_reservations', 'ck_cloud_ai_reservations_kind'],
      ['cloud_ai_usage', 'ck_cloud_ai_usage_kind'],
    ]) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${name}" CHECK ("kind" IN ${kinds})`,
      );
    }
  }
}
