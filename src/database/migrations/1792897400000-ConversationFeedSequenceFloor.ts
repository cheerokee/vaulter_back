import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  commitOrderedSyncTrigger,
  CONVERSATION_SYNC_FEED,
  ORIGINAL_POLICY_PREFIX,
} from '../../shared/infra/db/migration-helpers.js';

const TABLES = [
  'conversations',
  'conversation_participants',
  'conversation_key_grants',
  'conversation_messages',
  'conversation_attachments',
] as const;

// Defesa para bancos que rodaram ConversationFeedCommitOrder antes de ela travar as tabelas: um writer que confirmou
// entre a leitura do maior `sync_version` e a troca dos triggers pode ter deixado uma versão por xid acima do início
// da sequência. Com as cinco tabelas travadas (nenhuma versão nova no meio), a sequência passa a continuar acima do
// maior `sync_version` (o próximo `nextval` é maior que toda versão já servida). Idempotente; o `down` não desfaz nada
// (baixar a sequência poderia repetir versões).
// Também conserta bancos que rodaram a versão antiga de ConversationFeedCommitOrder (antes do `zz` e do prefixo dos
// comentários): renomeia `trg_<t>_sync_version` (em `mark_sync_pending`) para `trg_<t>_zz_sync_version` e põe o prefixo
// `sync-commit-original:` nos comentários de policy sem ele, para o `down` dela funcionar; ninguém precisa apagar o banco.
export class ConversationFeedSequenceFloor1792897400000 implements MigrationInterface {
  name = 'ConversationFeedSequenceFloor1792897400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `LOCK TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`,
    );
    for (const table of TABLES) {
      const old = (await queryRunner.query(
        `SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
          WHERE t.tgrelid = $1::regclass AND t.tgname = $2 AND p.proname = 'mark_sync_pending'
            AND NOT EXISTS (SELECT 1 FROM pg_trigger z WHERE z.tgrelid = $1::regclass AND z.tgname = $3)`,
        [table, `trg_${table}_sync_version`, commitOrderedSyncTrigger(table)],
      )) as unknown[];
      if (old.length > 0) {
        await queryRunner.query(
          `ALTER TRIGGER "trg_${table}_sync_version" ON "${table}" RENAME TO "${commitOrderedSyncTrigger(table)}"`,
        );
      }
      const comments = (await queryRunner.query(
        `SELECT pol.polname AS name, d.description
           FROM pg_policy pol JOIN pg_description d ON d.objoid = pol.oid AND d.classoid = 'pg_policy'::regclass
          WHERE pol.polrelid = $1::regclass AND starts_with(d.description, '{"qual"')`,
        [table],
      )) as { name: string; description: string }[];
      for (const c of comments) {
        const prefixed = `${ORIGINAL_POLICY_PREFIX}${c.description}`;
        await queryRunner.query(
          `COMMENT ON POLICY "${c.name}" ON "${table}" IS '${prefixed.replaceAll("'", "''")}'`,
        );
      }
    }
    const seq = CONVERSATION_SYNC_FEED.sequence;
    await queryRunner.query(`
      SELECT setval('"${seq}"', GREATEST(
        (SELECT last_value FROM "${seq}"),
        (SELECT COALESCE(MAX(v), 0) FROM (${TABLES.map((t) => `SELECT MAX(sync_version) AS v FROM "${t}"`).join(' UNION ALL ')}) m)
      ))
    `);
  }

  public async down(): Promise<void> {
    // Nothing to undo: lowering the sequence could hand out versions already served.
  }
}
