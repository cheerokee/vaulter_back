import { MigrationInterface, QueryRunner } from 'typeorm';

// Índices de manutenção que estavam nas Pendências do CLAUDE.md:
// - `storage_objects (space_id, COALESCE(updated_at, created_at))`: o `since` da listagem do backup filtra por essa
//   expressão (`BackupIndexSqlReader`); antes varria todos os objetos do espaço. Índice de expressão, declarado na
//   entidade com `synchronize: false` (o TypeORM não descreve expressão), como o HNSW dos trechos.
// - parciais por `deleted_at` para a retenção dos assuntos (`ConversationRetentionSqlStore.candidates`), que antes
//   varria `conversations` inteira: só as linhas com lápide que ainda têm o que zerar (corpo, anexo confirmado).
// Índices não mexem em policies nem triggers (o escape `sync_commit_in_progress` das tabelas dos feeds não muda).
export class MaintenanceIndexes1792898600000 implements MigrationInterface {
  name = 'MaintenanceIndexes1792898600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "ix_storage_objects_space_changed" ON "storage_objects" ("space_id", (COALESCE("updated_at", "created_at")))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_conversations_deleted" ON "conversations" ("deleted_at") WHERE "deleted_at" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_conversation_messages_retention" ON "conversation_messages" ("deleted_at") WHERE "deleted_at" IS NOT NULL AND "encrypted_body" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_conversation_attachments_retention" ON "conversation_attachments" ("deleted_at") WHERE "deleted_at" IS NOT NULL AND "status" = 'committed'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "ix_conversation_attachments_retention"`,
    );
    await queryRunner.query(`DROP INDEX "ix_conversation_messages_retention"`);
    await queryRunner.query(`DROP INDEX "ix_conversations_deleted"`);
    await queryRunner.query(`DROP INDEX "ix_storage_objects_space_changed"`);
  }
}
