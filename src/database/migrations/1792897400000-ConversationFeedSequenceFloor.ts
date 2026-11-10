import { MigrationInterface, QueryRunner } from 'typeorm';
import { CONVERSATION_SYNC_FEED } from '../../shared/infra/db/migration-helpers.js';

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
export class ConversationFeedSequenceFloor1792897400000 implements MigrationInterface {
  name = 'ConversationFeedSequenceFloor1792897400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `LOCK TABLE ${TABLES.map((t) => `"${t}"`).join(', ')} IN SHARE ROW EXCLUSIVE MODE`,
    );
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
