import { MigrationInterface, QueryRunner } from 'typeorm';
import { JOB_QUEUE_SCHEMA } from '../../shared/infra/jobs/pg-boss-schema.js';

const KEYED_QUEUES = [
  'cloud.index-space',
  'cloud.index-file',
  'cloud.answer-conversation',
];

// Filas com chave (Task 7, fix round 1): as filas da nuvem passam à política `stately` do pg-boss (uma tarefa à espera
// e no máximo UMA rodando por `singletonKey`, entre instâncias; `JobQueue.work(..., { oneJobPerKey: true })`). A política
// é fixada quando a fila nasce e o pg-boss recusa mudá-la pela API: num banco onde elas já existem (criadas `standard`
// pelas tasks anteriores), esta migration muda a linha da fila. As tarefas que já estavam na fila guardam a política
// antiga (rodam uma vez como antes); as novas seguem a nova. Num banco novo a fila ainda não existe e nasce `stately`.
export class CloudKeyedJobQueues1792898400000 implements MigrationInterface {
  name = 'CloudKeyedJobQueues1792898400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE ${JOB_QUEUE_SCHEMA}.queue SET policy = 'stately' WHERE name = ANY($1::text[])`,
      [KEYED_QUEUES],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE ${JOB_QUEUE_SCHEMA}.queue SET policy = 'standard' WHERE name = ANY($1::text[])`,
      [KEYED_QUEUES],
    );
  }
}
