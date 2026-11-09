import { MigrationInterface, QueryRunner } from 'typeorm';

// Primeira permissão financeira da plataforma (spec storage-backup §4.4): `platform.billing.storage_quota` ajusta a
// franquia de nuvem de uma organização. Vai para `platform_finance` (que até aqui não tinha nenhuma) e para
// `platform_admin` (que tem todas). O catálogo é imutável por migration: esta é a mudança, a CreatePlatformRoles não
// se edita. Ids fixos (UUID v7), como na semente original; o e2e confere banco == platform-catalog.ts.
const PERMISSION_ID = '01a1c1c7-d97a-7596-9dc8-07988c27a845';
const KEY = 'platform.billing.storage_quota';
const ROLE_KEYS = ['platform_admin', 'platform_finance'];

export class PlatformStorageQuotaPermission1792895900000 implements MigrationInterface {
  name = 'PlatformStorageQuotaPermission1792895900000';

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
