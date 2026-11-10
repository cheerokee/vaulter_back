import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  useSequenceSyncVersion,
  useXidSyncVersion,
  XID_SYNC_VERSION_SHIFT,
} from '../../shared/infra/db/migration-helpers.js';

const TABLES = [
  'conversations',
  'conversation_participants',
  'conversation_key_grants',
  'conversation_messages',
  'conversation_attachments',
] as const;
const MAX_ROW = 2 ** XID_SYNC_VERSION_SHIFT - 1;

// Horizonte seguro dos feeds de assuntos (pessoa e executor; `ConversationChangesSqlReader`): nas cinco tabelas que os
// feeds leem, `sync_version` passa a carregar o xid da transação que grava (`xid8 << 16 | n`, n = ordem da linha na
// transação), em vez da sequência global. O feed só entrega versões abaixo de `pg_snapshot_xmin(snapshot) << 16`: as
// de transações que já terminaram. Uma versão de uma transação ainda em andamento nunca fica para trás do cursor
// (`nextSince`), mesmo confirmando depois de outra mais nova. Algoritmo e consequências no comentário de
// `useXidSyncVersion` (migration-helpers.ts). O índice de `sync_version` continua o mesmo. Quem grava nessas tabelas
// (aplicação, CLI de retenção) passa sempre pelo trigger; o `GET /hub/sync` não lê estas tabelas e segue com a sequência.
export class ConversationFeedSafeHorizon1792896900000 implements MigrationInterface {
  name = 'ConversationFeedSafeHorizon1792896900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION set_xid_sync_version() RETURNS trigger AS $$
      DECLARE
        n bigint := COALESCE(NULLIF(current_setting('app.sync_row', true), ''), '0')::bigint;
      BEGIN
        -- O xid8 desta transação (atribuído aqui se ainda não havia) e a ordem da linha nela.
        NEW.sync_version := (pg_current_xact_id()::text::bigint << ${XID_SYNC_VERSION_SHIFT}) + LEAST(n, ${MAX_ROW});
        PERFORM set_config('app.sync_row', (n + 1)::text, true);
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    // Os cursores que os clientes já têm (versões da sequência) precisam ficar abaixo de toda versão nova.
    const [{ ok }] = (await queryRunner.query(`
      SELECT COALESCE(MAX(v), 0) < (pg_current_xact_id()::text::bigint << ${XID_SYNC_VERSION_SHIFT}) AS ok
        FROM (${TABLES.map((t) => `SELECT MAX(sync_version) AS v FROM "${t}"`).join(' UNION ALL ')}) m
    `)) as [{ ok: boolean }];
    if (!ok) {
      throw new Error(
        'ConversationFeedSafeHorizon: an existing sync_version is above the first xid-ordered version',
      );
    }
    for (const table of TABLES) await useXidSyncVersion(queryRunner, table);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES)
      await useSequenceSyncVersion(queryRunner, table);
    await queryRunner.query(`DROP FUNCTION set_xid_sync_version()`);
    // De volta à sequência: ela precisa passar das versões por xid, senão as gravações novas ficariam abaixo dos cursores.
    await queryRunner.query(`
      SELECT setval('sync_version_seq', GREATEST(
        (SELECT last_value FROM sync_version_seq),
        (SELECT COALESCE(MAX(v), 1) FROM (${TABLES.map((t) => `SELECT MAX(sync_version) AS v FROM "${t}"`).join(' UNION ALL ')}) m)
      ))
    `);
  }
}
