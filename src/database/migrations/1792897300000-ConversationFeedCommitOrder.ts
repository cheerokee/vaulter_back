import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addCommitOrderedSyncVersion,
  CONVERSATION_SYNC_FEED,
  createCommitOrderedSyncFeed,
  createCommitOrderedSyncFunctions,
  dropCommitOrderedSyncFunctions,
  dropCommitOrderedSyncVersion,
  XID_SYNC_VERSION_SHIFT,
} from '../../shared/infra/db/migration-helpers.js';

const TABLES = [
  'conversations',
  'conversation_participants',
  'conversation_key_grants',
  'conversation_messages',
  'conversation_attachments',
] as const;

const MAX_VERSION = `SELECT COALESCE(MAX(v), 0)::text AS v FROM (${TABLES.map((t) => `SELECT MAX(sync_version) AS v FROM "${t}"`).join(' UNION ALL ')}) m`;

// Versões dos feeds de assuntos atribuídas NO COMMIT, na ordem dos commits (substitui ConversationFeedSafeHorizon):
// nas cinco tabelas que os feeds leem, toda gravação deixa a linha provisória (`sync_pending`), e um constraint trigger
// adiado dá a versão no COMMIT, de UMA sequência (`conversation_sync_version_seq`), sob UM advisory lock de transação.
// Quem viu a versão V viu toda linha confirmada com versão <= V, sem depender de outra transação do banco, de xid nem
// do cluster (a versão por xid parava todos os feeds com qualquer transação longa do cluster, quebrava num restore
// lógico e empatava acima de 65.535 linhas por transação). Mecanismo e RLS no comentário de
// `addCommitOrderedSyncVersion` (migration-helpers.ts).
// - A sequência começa acima de toda versão já servida (o maior `sync_version` das cinco tabelas e o limite das
//   versões por xid desta transação): os cursores dos clientes continuam valendo.
// - `trg_conversation_participants_sync` passa a ter `WHEN (NEW.sync_pending)`: no UPDATE do commit ele travaria a
//   conversa (`FOR UPDATE`) depois do advisory lock. Os triggers de uso já são `UPDATE OF` colunas que o UPDATE do commit
//   não toca (não contam duas vezes); os de imutabilidade e o guarda de `participant_user_ids` não veem mudança; os de
//   NOTIFY disparam de novo (o Postgres junta os avisos repetidos e entrega no COMMIT, com as versões já dadas).
// - `down`: volta às versões por xid (ConversationFeedSafeHorizon). Recusa se alguma versão da sequência estiver no
//   limite da primeira versão por xid ou acima (só com mais de 65.535 linhas por transação, em média, desde o `up`).
export class ConversationFeedCommitOrder1792897300000 implements MigrationInterface {
  name = 'ConversationFeedCommitOrder1792897300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const [{ v }] = (await queryRunner.query(MAX_VERSION)) as [{ v: string }];
    const [{ x }] = (await queryRunner.query(
      `SELECT (pg_current_xact_id()::text::bigint << ${XID_SYNC_VERSION_SHIFT})::text AS x`,
    )) as [{ x: string }];
    const startAbove = BigInt(v) > BigInt(x) ? BigInt(v) : BigInt(x);
    await createCommitOrderedSyncFunctions(queryRunner);
    await createCommitOrderedSyncFeed(
      queryRunner,
      CONVERSATION_SYNC_FEED,
      startAbove,
    );
    for (const table of TABLES) {
      await addCommitOrderedSyncVersion(
        queryRunner,
        table,
        CONVERSATION_SYNC_FEED,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER "trg_conversation_participants_sync" ON "conversation_participants"`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversation_participants_sync" AFTER INSERT OR UPDATE ON "conversation_participants" ` +
        `FOR EACH ROW WHEN (NEW.sync_pending) EXECUTE FUNCTION conversation_participants_sync()`,
    );
    await queryRunner.query(`DROP FUNCTION set_xid_sync_version()`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ ok }] = (await queryRunner.query(`
      SELECT (${MAX_VERSION}) ::bigint < (pg_current_xact_id()::text::bigint << ${XID_SYNC_VERSION_SHIFT}) AS ok
    `)) as [{ ok: boolean }];
    if (!ok) {
      throw new Error(
        'ConversationFeedCommitOrder down: a commit-ordered sync_version is at or above the first xid-ordered version',
      );
    }
    const MAX_ROW = 2 ** XID_SYNC_VERSION_SHIFT - 1;
    await queryRunner.query(`
      CREATE FUNCTION set_xid_sync_version() RETURNS trigger AS $$
      DECLARE
        n bigint := COALESCE(NULLIF(current_setting('app.sync_row', true), ''), '0')::bigint;
      BEGIN
        NEW.sync_version := (pg_current_xact_id()::text::bigint << ${XID_SYNC_VERSION_SHIFT}) + LEAST(n, ${MAX_ROW});
        PERFORM set_config('app.sync_row', (n + 1)::text, true);
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `DROP TRIGGER "trg_conversation_participants_sync" ON "conversation_participants"`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversation_participants_sync" AFTER INSERT OR UPDATE ON "conversation_participants" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_participants_sync()`,
    );
    for (const table of TABLES) {
      await dropCommitOrderedSyncVersion(queryRunner, table);
      await queryRunner.query(
        `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
          `FOR EACH ROW EXECUTE FUNCTION set_xid_sync_version()`,
      );
    }
    await queryRunner.query(
      `DROP SEQUENCE "${CONVERSATION_SYNC_FEED.sequence}"`,
    );
    await dropCommitOrderedSyncFunctions(queryRunner);
  }
}
