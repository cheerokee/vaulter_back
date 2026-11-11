import type { MigrationInterface, QueryRunner } from 'typeorm';
import {
  JOB_QUEUE_SCHEMA,
  pgBossConstructionSql,
} from '../../shared/infra/jobs/pg-boss-schema.js';

// Fila de tarefas em segundo plano (pg-boss) no próprio Postgres, schema próprio `pgboss`, instalado aqui pelo login
// DONO (a API sobe o pg-boss com `migrate: false`, com o login de runtime). Exceção documentada às regras de tabela,
// como `rate_limit_hits`: tabelas técnicas da biblioteca, sem timestamps/lápides/RLS e com DELETE para o runtime (o
// pg-boss apaga tarefas concluídas e vencidas). Payloads só com ids (`JobQueue`): nada legível vai para lá.
// Nada de DDL em tempo de execução: filas sem `partition` (tabela `job_common`), `persistQueueStats` e `reindex`
// desligados no PgBossJobQueue. Atualizar o pg-boss com versão de schema nova: veja `pgBossConstructionSql`.
export class CreateJobQueue1792897500000 implements MigrationInterface {
  name = 'CreateJobQueue1792897500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(pgBossConstructionSql());
    const s = JOB_QUEUE_SCHEMA;
    await queryRunner.query(`GRANT USAGE ON SCHEMA ${s} TO app_runtime`);
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO app_runtime`,
    );
    await queryRunner.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO app_runtime`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO app_runtime`,
    );
    // Tabelas/funções que uma migration futura do pg-boss criar (com o dono) já nascem com as mesmas permissões.
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT USAGE, SELECT ON SEQUENCES TO app_runtime`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} GRANT EXECUTE ON FUNCTIONS TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const s = JOB_QUEUE_SCHEMA;
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON TABLES FROM app_runtime`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON SEQUENCES FROM app_runtime`,
    );
    await queryRunner.query(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA ${s} REVOKE ALL ON FUNCTIONS FROM app_runtime`,
    );
    await queryRunner.query(`DROP SCHEMA ${s} CASCADE`);
  }
}
