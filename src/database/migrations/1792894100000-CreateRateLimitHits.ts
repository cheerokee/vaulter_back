import type { MigrationInterface, QueryRunner } from 'typeorm';

// Contadores do rate limit (PostgresThrottlerStorage). Exceção documentada às regras de tabela:
// é contador técnico, não dado de cliente nem sincronizável, então não tem created_at/updated_at/
// deleted_at/sync_version, não é entidade TypeORM (o migration:generate ignora a tabela) e o papel de
// runtime pode dar DELETE (limpeza das linhas expiradas), só nela. UNLOGGED: sem WAL, perde-se o
// contador num crash do banco, o que é aceitável.
export class CreateRateLimitHits1792894100000 implements MigrationInterface {
  name = 'CreateRateLimitHits1792894100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE UNLOGGED TABLE rate_limit_hits (
        key text PRIMARY KEY,
        hits integer NOT NULL,
        expires_at timestamptz NOT NULL,
        blocked_until timestamptz
      )
    `);
    await queryRunner.query(
      `CREATE INDEX rate_limit_hits_expires_at_idx ON rate_limit_hits (expires_at)`,
    );
    // SELECT/INSERT/UPDATE já vêm dos default privileges; DELETE só nesta tabela.
    await queryRunner.query(`GRANT DELETE ON rate_limit_hits TO app_runtime`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE rate_limit_hits`);
  }
}
