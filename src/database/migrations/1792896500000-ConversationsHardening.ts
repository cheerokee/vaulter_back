import { MigrationInterface, QueryRunner } from 'typeorm';

// Colunas que nunca mudam depois do INSERT, por tabela. Mudar a conversa de uma participação (ou o destinatário de uma
// cópia) escaparia do trigger que recalcula participant_user_ids (ele só olha NEW.conversation_id) e moveria linhas entre
// conversas por baixo do RLS.
const IMMUTABLE: [table: string, columns: string[]][] = [
  ['conversations', ['organization_id', 'space_id', 'created_by_user_id']],
  [
    'conversation_participants',
    ['organization_id', 'conversation_id', 'user_id'],
  ],
  [
    'conversation_key_grants',
    ['organization_id', 'conversation_id', 'key_version', 'user_id', 'hub_id'],
  ],
  [
    'conversation_messages',
    [
      'organization_id',
      'conversation_id',
      'author_user_id',
      'author_hub_id',
      'key_version',
    ],
  ],
  [
    'conversation_attachments',
    ['organization_id', 'conversation_id', 'key_version'],
  ],
];

// Endurece as tabelas das conversas (revisão da Task 2):
// - BEFORE UPDATE `trg_<tabela>_immutable`: recusa (check_violation) mudança nas colunas de identidade da linha
//   (organização, conversa, pessoa/Hub, versão da chave). Uma função só; as colunas vão como argumentos do trigger.
// - CHECK `ck_conversations_header_retention`: cabeçalho nulo só com lápide (a retenção zera o de assunto apagado), como
//   o `ck_conversation_messages_body_retention`.
// - O cabeçalho da CreateConversations foi corrigido (só comentário): Hub que deixa de valer roda no contexto de um
//   participante, nunca no do próprio Hub.
export class ConversationsHardening1792896500000 implements MigrationInterface {
  name = 'ConversationsHardening1792896500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION conversation_rows_immutable() RETURNS trigger AS $$
      DECLARE
        col text;
      BEGIN
        FOREACH col IN ARRAY TG_ARGV LOOP
          IF (to_jsonb(NEW) -> col) IS DISTINCT FROM (to_jsonb(OLD) -> col) THEN
            RAISE EXCEPTION '%.% cannot change', TG_TABLE_NAME, col USING ERRCODE = 'check_violation';
          END IF;
        END LOOP;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    for (const [table, columns] of IMMUTABLE) {
      await queryRunner.query(
        `CREATE TRIGGER "trg_${table}_immutable" BEFORE UPDATE ON "${table}" ` +
          `FOR EACH ROW EXECUTE FUNCTION conversation_rows_immutable(${columns.map((c) => `'${c}'`).join(', ')})`,
      );
    }
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "ck_conversations_header_retention" CHECK (("encrypted_header" IS NOT NULL) OR ("deleted_at" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "ck_conversations_header_retention"`,
    );
    for (const [table] of IMMUTABLE) {
      await queryRunner.query(
        `DROP TRIGGER "trg_${table}_immutable" ON "${table}"`,
      );
    }
    await queryRunner.query(`DROP FUNCTION conversation_rows_immutable()`);
  }
}
