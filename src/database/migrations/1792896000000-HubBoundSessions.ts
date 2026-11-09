import { MigrationInterface, QueryRunner } from 'typeorm';

const REASONS = `'logout', 'revoked', 'refresh_reuse', 'password_change', 'account_recovery'`;

// Login de pessoas pelo Hub (spec storage-backup §4.7): a sessão aberta por `POST /hub/user-sessions` guarda o Hub
// (`hub_id`, FK simples para `hubs`: a tabela não tem organização) e só ela tem a plataforma `hub` (CHECK). Motivo novo
// `hub_access_lost`: a pessoa perdeu todo papel no Hub, ou o Hub foi desregistrado.
// Sessões `hub` antigas (do `/auth/login`, sem Hub) não cabem no CHECK: são revogadas e passam a `other` (não há
// produção; quem as tinha faz login de novo pelo Hub). `user_sessions` não tem RLS; o runtime já tem SELECT/INSERT/
// UPDATE na tabela inteira, inclusive na coluna nova.
export class HubBoundSessions1792896000000 implements MigrationInterface {
  name = 'HubBoundSessions1792896000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "user_sessions" ADD "hub_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "user_sessions" DROP CONSTRAINT "ck_user_sessions_revoked_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" ADD CONSTRAINT "ck_user_sessions_revoked_reason"
        CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN (${REASONS}, 'hub_access_lost'))`,
    );
    await queryRunner.query(
      `UPDATE "user_sessions"
          SET "device_platform" = 'other',
              "revoked_at" = COALESCE("revoked_at", now()),
              "revoked_reason" = COALESCE("revoked_reason", 'hub_access_lost')
        WHERE "device_platform" = 'hub'`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" ADD CONSTRAINT "ck_user_sessions_hub_bound"
        CHECK (("device_platform" = 'hub') = ("hub_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" ADD CONSTRAINT "fk_user_sessions_hubs"
        FOREIGN KEY ("hub_id") REFERENCES "hubs" ("id") ON DELETE NO ACTION ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_user_sessions_hub" ON "user_sessions" ("hub_id", "user_id")
        WHERE "hub_id" IS NOT NULL AND "revoked_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "ix_user_sessions_hub"`);
    await queryRunner.query(
      `ALTER TABLE "user_sessions" DROP CONSTRAINT "fk_user_sessions_hubs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" DROP CONSTRAINT "ck_user_sessions_hub_bound"`,
    );
    await queryRunner.query(
      `UPDATE "user_sessions" SET "revoked_reason" = 'revoked' WHERE "revoked_reason" = 'hub_access_lost'`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" DROP CONSTRAINT "ck_user_sessions_revoked_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" ADD CONSTRAINT "ck_user_sessions_revoked_reason"
        CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN (${REASONS}))`,
    );
    await queryRunner.query(`ALTER TABLE "user_sessions" DROP COLUMN "hub_id"`);
  }
}
