import { MigrationInterface, QueryRunner } from 'typeorm';

// Segunda permissão financeira da plataforma (spec active-cloud §4.4): `platform.billing.ai_budget` ajusta o orçamento
// mensal de IA de uma organização. Vai para `platform_finance` e `platform_admin` (que tem todas). O catálogo é
// imutável por migration: esta é a mudança. Id fixo (UUID v7); o e2e confere banco == platform-catalog.ts.
const PERMISSION_ID = '01a1c89c-750b-70c2-8b2a-b38ec8af6c00';
const KEY = 'platform.billing.ai_budget';
const ROLE_KEYS = ['platform_admin', 'platform_finance'];

export class PlatformAiBudgetPermission1792897900000 implements MigrationInterface {
  name = 'PlatformAiBudgetPermission1792897900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "platform_permissions" ("id", "key") VALUES ($1, $2)`,
      [PERMISSION_ID, KEY],
    );
    await queryRunner.query(
      `INSERT INTO "platform_role_permission" ("platform_role_id", "platform_permission_id")
       SELECT "id", $1 FROM "platform_roles" WHERE "key" = ANY($2) AND "deleted_at" IS NULL`,
      [PERMISSION_ID, ROLE_KEYS],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "platform_role_permission" WHERE "platform_permission_id" = $1`,
      [PERMISSION_ID],
    );
    await queryRunner.query(
      `DELETE FROM "platform_permissions" WHERE "id" = $1`,
      [PERMISSION_ID],
    );
  }
}
