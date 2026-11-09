import { MigrationInterface, QueryRunner } from 'typeorm';

// Controle da lixeira do backup (spec storage-backup §4.8, decisão do Jonas de 2026-11-09):
// - status novo `purged` em `storage_object_versions`: versão confirmada apagada de vez da lixeira (o Gestor esvaziou a
//   lixeira, ou a versão passou do limite de 10 versões antigas por objeto). Continua com `s3_version_id` e
//   `committed_at` (o CHECK `committed` passa a valer para `committed` e `purged`), sai do uso, das listagens e dos
//   downloads (todos filtram `status = 'committed'`) e o reparo a trata como não referenciada (apaga do S3);
// - `purged_at` (relógio do banco), presente exatamente nas linhas `purged`, que sempre são substituídas
//   (`superseded_at`): nunca a versão viva de um objeto vivo.
// Sem dado a migrar (nenhuma linha `purged` antes desta migration).
export class StorageTrashPurge1792896300000 implements MigrationInterface {
  name = 'StorageTrashPurge1792896300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" ADD COLUMN "purged_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" DROP CONSTRAINT "ck_storage_object_versions_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "ck_storage_object_versions_status" CHECK ("status" IN ('pending', 'committed', 'expired', 'purged'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" DROP CONSTRAINT "ck_storage_object_versions_committed"`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "ck_storage_object_versions_committed" CHECK (("status" IN ('committed', 'purged')) = ("s3_version_id" IS NOT NULL AND "committed_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "ck_storage_object_versions_purged" CHECK (("status" = 'purged') = ("purged_at" IS NOT NULL AND "superseded_at" IS NOT NULL))`,
    );
  }

  // Reverter exige que não haja linhas `purged` (os CHECKs antigos as recusam): elas voltariam a contar no uso.
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" DROP CONSTRAINT "ck_storage_object_versions_purged"`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" DROP CONSTRAINT "ck_storage_object_versions_committed"`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "ck_storage_object_versions_committed" CHECK (("status" = 'committed') = ("s3_version_id" IS NOT NULL AND "committed_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" DROP CONSTRAINT "ck_storage_object_versions_status"`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "ck_storage_object_versions_status" CHECK ("status" IN ('pending', 'committed', 'expired'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" DROP COLUMN "purged_at"`,
    );
  }
}
