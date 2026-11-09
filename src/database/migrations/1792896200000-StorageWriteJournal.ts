import { MigrationInterface, QueryRunner } from 'typeorm';

// Diário das gravações no S3 do backup (spec storage-backup §4.2; reparo do índice × bucket):
// - `storage_object_versions.s3_write_started_at`: "alguma tentativa de gravar no S3 por esta linha começou neste
//   instante ou depois" (relógio do banco). Gravado numa transação curta própria, confirmada ANTES da transação que
//   copia ou grava o delete marker, e renovado a cada tentativa. NUNCA é limpo no commit (uma cópia abortada de outra
//   tentativa ainda pode chegar ao S3): só a varredura do reparo limpa as marcas com mais de 60 min, depois de reparar
//   o objeto. O reparo (`BackupObjectHealer`) apaga do bucket as versões e markers que nenhuma versão confirmada do
//   índice referencia. (Comentário corrigido depois; o SQL desta migration não mudou.)
// - Índice parcial só das linhas marcadas (a varredura procura as antigas).
// - Policy `storage_reconcile_read` (só SELECT, permissiva): com `app.storage_reconcile = 'on'` (contexto de
//   confiança do backend, só pela varredura `ReconcileStorageUseCase`), o runtime lê as linhas MARCADAS de qualquer
//   organização para saber quais objetos reparar; o reparo em si roda no escopo da organização de cada uma.
export class StorageWriteJournal1792896200000 implements MigrationInterface {
  name = 'StorageWriteJournal1792896200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" ADD COLUMN "s3_write_started_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_storage_object_versions_s3_write_started" ON "storage_object_versions" ("s3_write_started_at") WHERE "s3_write_started_at" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE POLICY "storage_reconcile_read" ON "storage_object_versions" FOR SELECT ` +
        `USING (current_setting('app.storage_reconcile', true) = 'on' AND "s3_write_started_at" IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY IF EXISTS "storage_reconcile_read" ON "storage_object_versions"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "ix_storage_object_versions_s3_write_started"`,
    );
    await queryRunner.query(
      `ALTER TABLE "storage_object_versions" DROP COLUMN "s3_write_started_at"`,
    );
  }
}
