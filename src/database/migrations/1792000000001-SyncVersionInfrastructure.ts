import type { MigrationInterface, QueryRunner } from 'typeorm';

// Sequência global de sync_version e a função de trigger usada pelas tabelas sincronizáveis.
// Roda depois de AppRuntimeRole: os default privileges dela dão USAGE na sequência ao app_runtime.
export class SyncVersionInfrastructure1792000000001 implements MigrationInterface {
  name = 'SyncVersionInfrastructure1792000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE SEQUENCE sync_version_seq`);
    await queryRunner.query(`
      CREATE FUNCTION set_sync_version() RETURNS trigger AS $$
      BEGIN
        NEW.sync_version := nextval('sync_version_seq');
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP FUNCTION set_sync_version()`);
    await queryRunner.query(`DROP SEQUENCE sync_version_seq`);
  }
}
