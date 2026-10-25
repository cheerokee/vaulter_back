import type { MigrationInterface, QueryRunner } from 'typeorm';

// Permissões do papel de runtime da API. O login em si (e a senha) é criado fora das migrations,
// por .docker/postgres/init/02-app-role.sh; aqui só existe o papel de grupo app_runtime.
// Sem DELETE de propósito: o que sincroniza nunca sofre exclusão física (soft delete).
export class AppRuntimeRole1792000000000 implements MigrationInterface {
  name = 'AppRuntimeRole1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
          CREATE ROLE app_runtime NOLOGIN NOBYPASSRLS;
        END IF;
      END
      $$
    `);
    await queryRunner.query(`GRANT USAGE ON SCHEMA public TO app_runtime`);
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE ON TABLES TO app_runtime`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE USAGE, SELECT ON SEQUENCES FROM app_runtime`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT, INSERT, UPDATE ON TABLES FROM app_runtime`,
    );
    await queryRunner.query(`REVOKE USAGE ON SCHEMA public FROM app_runtime`);
  }
}
