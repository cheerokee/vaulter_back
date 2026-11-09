import { MigrationInterface, QueryRunner } from 'typeorm';

// Proteção depois da nomeação pela plataforma (decisão do Jonas, 09/11/2026; spec platform-roles §4.4):
// - `platform_appointed_user_id`, `platform_appointed_at`, `protected_until`: a última nomeação de admin pela
//   plataforma; enquanto `now < protected_until`, ninguém da organização registra/troca o kit nem remove membro.
//   Os três andam juntos (CHECK); uma nomeação nova sobrescreve os três.
// - `recovery_key_changed_at`, `recovery_key_changed_by_user_id`: quando e quem trocou o kit pela última vez (o app
//   avisa os membros antes de retrancar).
// Colunas anuláveis: linhas existentes ficam sem nomeação e sem troca registrada. O runtime já tem UPDATE na tabela
// inteira (privilégio padrão da AppRuntimeRole, sem GRANT por coluna em `organizations`), nada a conceder.
export class OrganizationPlatformProtection1792895700000 implements MigrationInterface {
  name = 'OrganizationPlatformProtection1792895700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD COLUMN "recovery_key_changed_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "recovery_key_changed_by_user_id" uuid,
        ADD COLUMN "platform_appointed_user_id" uuid,
        ADD COLUMN "platform_appointed_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "protected_until" TIMESTAMP WITH TIME ZONE,
        ADD CONSTRAINT "ck_organizations_platform_appointment" CHECK (("platform_appointed_user_id" IS NULL) = ("platform_appointed_at" IS NULL) AND ("platform_appointed_at" IS NULL) = ("protected_until" IS NULL)),
        ADD CONSTRAINT "ck_organizations_recovery_key_changed" CHECK (("recovery_key_changed_at" IS NULL) = ("recovery_key_changed_by_user_id" IS NULL)),
        ADD CONSTRAINT "fk_organizations_recovery_key_changed_by" FOREIGN KEY ("recovery_key_changed_by_user_id") REFERENCES "users" ("id"),
        ADD CONSTRAINT "fk_organizations_platform_appointed_user" FOREIGN KEY ("platform_appointed_user_id") REFERENCES "users" ("id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "organizations"
        DROP CONSTRAINT "fk_organizations_platform_appointed_user",
        DROP CONSTRAINT "fk_organizations_recovery_key_changed_by",
        DROP CONSTRAINT "ck_organizations_recovery_key_changed",
        DROP CONSTRAINT "ck_organizations_platform_appointment",
        DROP COLUMN "protected_until",
        DROP COLUMN "platform_appointed_at",
        DROP COLUMN "platform_appointed_user_id",
        DROP COLUMN "recovery_key_changed_by_user_id",
        DROP COLUMN "recovery_key_changed_at"
    `);
  }
}
