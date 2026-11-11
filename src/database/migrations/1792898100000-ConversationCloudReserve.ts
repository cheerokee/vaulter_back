import { MigrationInterface, QueryRunner } from 'typeorm';
import { ORIGINAL_POLICY_PREFIX } from '../../shared/infra/db/migration-helpers.js';

const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;
const CLOUD = `NULLIF(current_setting('app.cloud_executor', true), '')::uuid`;
const ESCAPE = 'sync_commit_in_progress()';

// The conversation policies before this migration (CreateConversations) and after it.
const ACCESS_BEFORE = `(${USER} = ANY ("participant_user_ids") OR "executor_hub_id" = ${HUB})`;
const CLOUD_ACCESS = `("cloud_reserve" AND "deleted_at" IS NULL AND "space_id" = ${CLOUD})`;
const ACCESS_AFTER = `(${USER} = ANY ("participant_user_ids") OR "executor_hub_id" = ${HUB} OR ${CLOUD_ACCESS})`;

const IMMUTABLE_GRANTS_BEFORE = [
  'organization_id',
  'conversation_id',
  'key_version',
  'user_id',
  'hub_id',
];
const IMMUTABLE_MESSAGES_BEFORE = [
  'organization_id',
  'conversation_id',
  'author_user_id',
  'author_hub_id',
  'key_version',
];

// Tables the cloud context never writes (it only reads them and writes messages / the conversation's work state).
const NO_CLOUD_WRITE_TABLES = [
  'conversation_participants',
  'conversation_key_grants',
  'conversation_attachments',
] as const;

// A nuvem como executor de reserva dos assuntos (spec active-cloud §4.3, primeiro parágrafo; módulo `conversations`).
// - `conversations.cloud_reserve`: o assunto tem a nuvem de reserva (espaço em `active_cloud` + cópias da chave do
//   assunto para a chave do servidor). `cloud_reserve_declined`: o DONO desligou (só ele religa; um participante que
//   abre o assunto no app não a liga de volta). CHECKs: nunca os dois; nunca reserva num assunto com lápide.
// - `conversation_key_grants.server_recipient`: a cópia é para a chave do servidor. CHECK: exatamente um destinatário
//   (pessoa, Hub OU servidor); uma cópia viva por (assunto, versão) do servidor. As cópias do servidor nunca saem num
//   feed (os feeds só entregam as cópias de quem lê) e são APAGADAS de verdade quando deixam de valer (dono desliga,
//   espaço sai da nuvem ativa, assunto ganha lápide): a cópia é material de chave que o servidor abre, e nenhum feed
//   precisa da lápide dela. Exceção documentada à regra do soft delete, como as tabelas do `cloud`: GRANT DELETE ao
//   runtime, limitado pela policy RESTRITIVA `conversation_server_copy_delete` às linhas `server_recipient`.
// - `conversation_messages.author_cloud` / `acked_by_cloud`: a nuvem como autora (nasce confirmada, como o Hub) e como
//   quem confirmou (`ack`). CHECKs: exatamente um autor; confirmada por no máximo um (Hub ou nuvem).
// - Colunas novas de identidade imutáveis (`server_recipient`, `author_cloud`): os triggers `trg_<t>_immutable` são
//   recriados com elas (nome < `zz`: continuam antes do `trg_<t>_zz_sync_version`).
// - RLS: contexto novo `app.cloud_executor` = o id de UM espaço. Abre só os assuntos VIVOS desse espaço com
//   `cloud_reserve` (OR nas policies restritivas de SELECT/UPDATE de `conversations`; as filhas seguem a conversa
//   visível). Nunca um contexto "de confiança": um espaço por vez, só o que tem a reserva ligada. Que o espaço ainda
//   está em `active_cloud` é conferido pelo `conversations` (`SpaceCloud`, com o espaço travado) e mantido pelo gancho
//   do desligar (`SpaceCloudDeactivatedHooks`: a reserva cai em todo assunto do espaço, no contexto do dono).
//   Nesse contexto a nuvem não grava participações, cópias nem anexos (policies restritivas `conversation_no_cloud_write`)
//   e não cria assunto (a policy de INSERT de `conversations` não muda). As policies alteradas mantêm o escape
//   `sync_commit_in_progress()` (versões dadas no COMMIT; ConversationFeedCommitOrder) e o comentário com a expressão
//   original (prefixo `sync-commit-original:`).
export class ConversationCloudReserve1792898100000 implements MigrationInterface {
  name = 'ConversationCloudReserve1792898100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "cloud_reserve" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "cloud_reserve_declined" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "ck_conversations_cloud_reserve" CHECK (NOT ("cloud_reserve" AND "cloud_reserve_declined"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "ck_conversations_cloud_reserve_live" CHECK ((NOT "cloud_reserve") OR ("deleted_at" IS NULL))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_conversations_cloud_reserve" ON "conversations" ("space_id") WHERE "cloud_reserve"`,
    );

    await queryRunner.query(
      `ALTER TABLE "conversation_key_grants" ADD "server_recipient" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_key_grants" DROP CONSTRAINT "ck_conversation_key_grants_recipient"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_key_grants" ADD CONSTRAINT "ck_conversation_key_grants_recipient" CHECK ((num_nonnulls("user_id", "hub_id") + "server_recipient"::int) = 1)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_conversation_key_grants_server" ON "conversation_key_grants" ("conversation_id", "key_version") WHERE "server_recipient" AND "deleted_at" IS NULL`,
    );

    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD "author_cloud" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD "acked_by_cloud" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "ck_conversation_messages_author"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "ck_conversation_messages_author" CHECK ((num_nonnulls("author_user_id", "author_hub_id") + "author_cloud"::int) = 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "ck_conversation_messages_cloud_acked" CHECK ((NOT "author_cloud") OR (NOT "pending"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "ck_conversation_messages_acked_by_cloud" CHECK ((NOT "acked_by_cloud") OR ((NOT "pending") AND ("acked_by_hub_id" IS NULL)))`,
    );

    await this.immutable(queryRunner, 'conversation_key_grants', [
      ...IMMUTABLE_GRANTS_BEFORE,
      'server_recipient',
    ]);
    await this.immutable(queryRunner, 'conversation_messages', [
      ...IMMUTABLE_MESSAGES_BEFORE,
      'author_cloud',
    ]);

    await this.conversationPolicies(queryRunner, ACCESS_AFTER);

    await queryRunner.query(
      `GRANT DELETE ON "conversation_key_grants" TO app_runtime`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_server_copy_delete" ON "conversation_key_grants" AS RESTRICTIVE FOR DELETE USING ("server_recipient")`,
    );
    for (const table of NO_CLOUD_WRITE_TABLES) {
      await queryRunner.query(
        `CREATE POLICY "conversation_no_cloud_insert" ON "${table}" AS RESTRICTIVE FOR INSERT WITH CHECK (${CLOUD} IS NULL)`,
      );
      await queryRunner.query(
        `CREATE POLICY "conversation_no_cloud_update" ON "${table}" AS RESTRICTIVE FOR UPDATE ` +
          `USING (${ESCAPE} OR ${CLOUD} IS NULL) WITH CHECK (${ESCAPE} OR ${CLOUD} IS NULL)`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of NO_CLOUD_WRITE_TABLES) {
      await queryRunner.query(
        `DROP POLICY "conversation_no_cloud_update" ON "${table}"`,
      );
      await queryRunner.query(
        `DROP POLICY "conversation_no_cloud_insert" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP POLICY "conversation_server_copy_delete" ON "conversation_key_grants"`,
    );
    await queryRunner.query(
      `REVOKE DELETE ON "conversation_key_grants" FROM app_runtime`,
    );
    await this.conversationPolicies(queryRunner, ACCESS_BEFORE);
    await this.immutable(
      queryRunner,
      'conversation_messages',
      IMMUTABLE_MESSAGES_BEFORE,
    );
    await this.immutable(
      queryRunner,
      'conversation_key_grants',
      IMMUTABLE_GRANTS_BEFORE,
    );
    // Rows that only the new columns can describe (server copies, cloud messages) cannot go back: refuse loudly.
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "ck_conversation_messages_acked_by_cloud"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "ck_conversation_messages_cloud_acked"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "ck_conversation_messages_author"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "ck_conversation_messages_author" CHECK (num_nonnulls("author_user_id", "author_hub_id") = 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "acked_by_cloud"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "author_cloud"`,
    );
    await queryRunner.query(`DROP INDEX "uq_conversation_key_grants_server"`);
    await queryRunner.query(
      `ALTER TABLE "conversation_key_grants" DROP CONSTRAINT "ck_conversation_key_grants_recipient"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_key_grants" ADD CONSTRAINT "ck_conversation_key_grants_recipient" CHECK (num_nonnulls("user_id", "hub_id") = 1)`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_key_grants" DROP COLUMN "server_recipient"`,
    );
    await queryRunner.query(`DROP INDEX "ix_conversations_cloud_reserve"`);
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "ck_conversations_cloud_reserve_live"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "ck_conversations_cloud_reserve"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "cloud_reserve_declined"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "cloud_reserve"`,
    );
  }

  private async immutable(
    qr: QueryRunner,
    table: string,
    columns: string[],
  ): Promise<void> {
    await qr.query(`DROP TRIGGER "trg_${table}_immutable" ON "${table}"`);
    await qr.query(
      `CREATE TRIGGER "trg_${table}_immutable" BEFORE UPDATE ON "${table}" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_rows_immutable(${columns.map((c) => `'${c}'`).join(', ')})`,
    );
  }

  // The restrictive SELECT/UPDATE policies of `conversations`, with the commit-time escape and the original expression
  // kept in the COMMENT (the down of ConversationFeedCommitOrder reads it).
  private async conversationPolicies(
    qr: QueryRunner,
    access: string,
  ): Promise<void> {
    await qr.query(
      `ALTER POLICY "conversation_read" ON "conversations" USING (${ESCAPE} OR ${access})`,
    );
    await qr.query(
      `ALTER POLICY "conversation_update" ON "conversations" USING (${ESCAPE} OR ${access}) WITH CHECK (${ESCAPE} OR true)`,
    );
    for (const [name, withCheck] of [
      ['conversation_read', null],
      ['conversation_update', 'true'],
    ] as const) {
      const original =
        ORIGINAL_POLICY_PREFIX + JSON.stringify({ qual: access, withCheck });
      await qr.query(
        `COMMENT ON POLICY "${name}" ON "conversations" IS '${original.replaceAll("'", "''")}'`,
      );
    }
  }
}
