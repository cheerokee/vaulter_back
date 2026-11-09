import { MigrationInterface, QueryRunner } from 'typeorm';

// Tamanho do espaço, franquia da organização e capacidade do Hub (spec storage-backup §4.4, §4.5, §4.9):
// - `spaces.storage_quota_bytes`: tamanho reservado, padrão 10 GiB; soma na franquia e na capacidade dos Hubs.
// - `organizations.storage_quota_bytes`: franquia de nuvem, padrão 50 GiB (o financeiro ajusta depois).
// - `hubs.storage_capacity_bytes`: capacidade do SSD informada pelo próprio Hub; nula até ele informar (sem conferência).
// Linhas existentes ganham os padrões (não há produção); organização que já nasce acima da franquia só fica impedida de
// reservar mais. `ADD COLUMN ... DEFAULT` não reescreve linhas nem dispara o trigger do sync_version.
// `hubs` tem GRANT de UPDATE por coluna (HardenHubsRls): a capacidade entra na lista. `spaces` e `organizations` já
// têm UPDATE na tabela inteira para o runtime.
export class StorageQuotas1792895800000 implements MigrationInterface {
  name = 'StorageQuotas1792895800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "spaces"
        ADD COLUMN "storage_quota_bytes" bigint NOT NULL DEFAULT '10737418240',
        ADD CONSTRAINT "ck_spaces_storage_quota_bytes" CHECK ("storage_quota_bytes" > 0)
    `);
    await queryRunner.query(`
      ALTER TABLE "organizations"
        ADD COLUMN "storage_quota_bytes" bigint NOT NULL DEFAULT '53687091200',
        ADD CONSTRAINT "ck_organizations_storage_quota_bytes" CHECK ("storage_quota_bytes" > 0)
    `);
    await queryRunner.query(`
      ALTER TABLE "hubs"
        ADD COLUMN "storage_capacity_bytes" bigint,
        ADD CONSTRAINT "ck_hubs_storage_capacity_bytes" CHECK ("storage_capacity_bytes" > 0)
    `);
    await queryRunner.query(
      `GRANT UPDATE ("storage_capacity_bytes") ON "hubs" TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `REVOKE UPDATE ("storage_capacity_bytes") ON "hubs" FROM app_runtime`,
    );
    await queryRunner.query(`
      ALTER TABLE "hubs"
        DROP CONSTRAINT "ck_hubs_storage_capacity_bytes",
        DROP COLUMN "storage_capacity_bytes"
    `);
    await queryRunner.query(`
      ALTER TABLE "organizations"
        DROP CONSTRAINT "ck_organizations_storage_quota_bytes",
        DROP COLUMN "storage_quota_bytes"
    `);
    await queryRunner.query(`
      ALTER TABLE "spaces"
        DROP CONSTRAINT "ck_spaces_storage_quota_bytes",
        DROP COLUMN "storage_quota_bytes"
    `);
  }
}
