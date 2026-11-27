import { MigrationInterface, QueryRunner } from 'typeorm';
import { ORIGINAL_POLICY_PREFIX } from '../../shared/infra/db/migration-helpers.js';

const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;
const CLOUD = `NULLIF(current_setting('app.cloud_executor', true), '')::uuid`;
const ESCAPE = 'sync_commit_in_progress()';

// A uuid setting that may also hold 'scan': the CASE keeps the cast from failing on 'scan' (and on '' / unset).
const uuidSetting = (name: string) =>
  `(CASE WHEN current_setting('${name}', true) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' ` +
  `THEN current_setting('${name}', true)::uuid END)`;

// Retention of the conversations: 'scan' (find the candidates) or the id of ONE conversation (purge it).
const RETENTION_SCAN = `current_setting('app.conversation_retention', true) = 'scan'`;
const RETENTION_ID = uuidSetting('app.conversation_retention');
// Reconcile of `conversation_space_usage`: 'scan' (list the counters) or the id of ONE space (recount it).
const RECONCILE_SCAN = `current_setting('app.conversation_usage_reconcile', true) = 'scan'`;
const RECONCILE_ID = uuidSetting('app.conversation_usage_reconcile');
const HUB_CLEANUP = `current_setting('app.hub_registry_cleanup', true) = 'on'`;
const PROPOSAL_RETENTION = `current_setting('app.agent_proposal_retention', true) = 'on'`;

// = CONVERSATION_RETENTION_DAYS, HUB_REGISTRY_RETENTION_DAYS and AGENT_PROPOSAL_RETENTION_DAYS (domain). Changing one
// of them is a new migration: the policy is what keeps a routine from touching a row inside the window.
const CUTOFF = `(now() - interval '30 days')`;

// The conversation policies before this migration (ConversationCloudReserve) and after it.
const ACCESS = `(${USER} = ANY ("participant_user_ids") OR "executor_hub_id" = ${HUB} OR ("cloud_reserve" AND "deleted_at" IS NULL AND "space_id" = ${CLOUD}))`;
const CONVERSATION_SCAN = `(${RETENTION_SCAN} AND "deleted_at" < ${CUTOFF})`;
const CONVERSATION_PURGE = `("id" = ${RETENTION_ID})`;
const CONVERSATION_RECONCILE = `("space_id" = ${RECONCILE_ID})`;
const READ_AFTER = `(${ACCESS} OR ${CONVERSATION_SCAN} OR ${CONVERSATION_PURGE} OR ${CONVERSATION_RECONCILE})`;
const UPDATE_AFTER = `(${ACCESS} OR ${CONVERSATION_PURGE})`;

const visible = (table: string) => `EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.id = ${table}.conversation_id AND c.organization_id = ${table}.organization_id)`;
const parentPast = (table: string) => `EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.id = ${table}.conversation_id AND c.organization_id = ${table}.organization_id
     AND c.deleted_at < ${CUTOFF})`;
const parentInSpace = (table: string) => `EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.id = ${table}.conversation_id AND c.organization_id = ${table}.organization_id
     AND c.space_id = ${RECONCILE_ID})`;
const spaceOfPurged = (table: string) => `EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.id = ${RETENTION_ID} AND c.space_id = ${table}.space_id AND c.organization_id = ${table}.organization_id)`;

// Content past the window (what the retention nulls): tombstoned more than 30 days ago, itself or with the conversation.
const MESSAGE_DUE = `("encrypted_body" IS NOT NULL AND ("deleted_at" < ${CUTOFF} OR ${parentPast('conversation_messages')}))`;
const ATTACHMENT_DUE = `("status" = 'committed' AND ("deleted_at" < ${CUTOFF} OR ${parentPast('conversation_attachments')}))`;

const MESSAGE_LEASE = `(current_setting('app.agent_lease_sweep', true) = 'on' AND "acked_lease_until" IS NOT NULL)`;
const MESSAGE_READ_BEFORE = `(${ESCAPE} OR ${visible('conversation_messages')} OR ${MESSAGE_LEASE})`;
const MESSAGE_READ_AFTER = `(${ESCAPE} OR ${visible('conversation_messages')} OR ${MESSAGE_LEASE} OR (${RETENTION_SCAN} AND ${MESSAGE_DUE}))`;
const ATTACHMENT_RECONCILE = `current_setting('app.storage_reconcile', true) = 'on'`;
const ATTACHMENT_READ_BEFORE = `(${ESCAPE} OR (${visible('conversation_attachments')} OR ${ATTACHMENT_RECONCILE}))`;
const ATTACHMENT_READ_AFTER = `(${ESCAPE} OR (${visible('conversation_attachments')} OR ${ATTACHMENT_RECONCILE}) OR (${RETENTION_SCAN} AND ${ATTACHMENT_DUE}))`;

const HUB_REGISTRY_TABLES = [
  'hub_enrollments',
  'hub_link_codes',
  'hub_auth_challenges',
] as const;

const GUARD_BEFORE = `
      BEGIN
        IF pg_trigger_depth() < 2 AND NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
        ) THEN
          RAISE EXCEPTION '% is maintained only by the conversation triggers', TG_TABLE_NAME
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
      END
      `;
const GUARD_AFTER = `
      BEGIN
        IF pg_trigger_depth() < 2 AND NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
        ) AND NOT (
          TG_TABLE_NAME = 'conversation_space_usage'
          AND COALESCE(current_setting('app.conversation_usage_reconcile', true), '') = NEW.space_id::text
        ) THEN
          RAISE EXCEPTION '% is maintained only by the conversation triggers', TG_TABLE_NAME
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
      END
      `;

// Contextos de confiança das rotinas de manutenção (decisão B7 do Jonas, 26/11/2026: contexto nas policies, nunca um
// papel com BYPASSRLS). Regras: um contexto por rotina (nunca um "abre tudo"); cada policy abre só as linhas candidatas
// da rotina; nenhum deles põe `app.organization_id` (o que abriria a organização inteira); as policies alteradas dos
// assuntos mantêm o escape `sync_commit_in_progress()`; DELETE físico só com GRANT + policy daquele contexto. O e2e
// `test/shared/trusted-contexts.e2e-spec.ts` prova, por contexto, que ele não enxerga nada além.
// - `app.conversation_retention` (retenção dos assuntos, `ConversationRetention`): 'scan' lê só o que passou da janela
//   (assunto com lápide há mais de 30 dias; corpo de mensagem e anexo confirmado com lápide há mais de 30 dias ou de um
//   assunto assim); o id de UM assunto abre esse assunto (ler e travar; gravar só o cabeçalho de um assunto com lápide
//   vencida), as mensagens/anexos dele vencidos (e os já zerados/`purged`), com WITH CHECK que só aceita zerar/`purged`,
//   e as linhas de uso do espaço dele (os triggers de uso gravam ali). Participações e cópias da chave ficam invisíveis.
// - `app.conversation_usage_reconcile` (varredura do contador `conversation_space_usage`): 'scan' lê os contadores (só
//   números); o id de UM espaço lê os assuntos e as mensagens desse espaço (só leitura: nenhuma policy de escrita) e
//   lê/grava o contador dele; o trigger de guarda deixa a escrita direta só nessa linha.
// - `app.hub_registry_cleanup` (limpeza das tabelas de cadastro do Hub, que não tinham RLS): RLS ligado com
//   SELECT/INSERT/UPDATE abertos como antes; DELETE (GRANT novo) só nesse contexto e só de linha vencida há 30 dias.
// - `app.agent_proposal_retention` (retenção de `agent_issued_proposals`): SELECT/DELETE (GRANT novo) só das propostas
//   com mais de 30 dias.
export class MaintenanceTrustedContexts1792899900000 implements MigrationInterface {
  name = 'MaintenanceTrustedContexts1792899900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- conversations
    await this.conversationPolicies(queryRunner, READ_AFTER, UPDATE_AFTER);
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_read" ON "conversations" FOR SELECT ` +
        `USING (${CONVERSATION_SCAN} OR ${CONVERSATION_PURGE})`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_update" ON "conversations" FOR UPDATE ` +
        `USING (${CONVERSATION_PURGE}) ` +
        `WITH CHECK (${CONVERSATION_PURGE} AND "deleted_at" < ${CUTOFF} AND "encrypted_header" IS NULL)`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_usage_reconcile_read" ON "conversations" FOR SELECT ` +
        `USING (${CONVERSATION_RECONCILE})`,
    );

    // --- messages
    await this.childRead(
      queryRunner,
      'conversation_messages',
      MESSAGE_READ_AFTER,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_read" ON "conversation_messages" FOR SELECT ` +
        `USING ((${RETENTION_SCAN} AND ${MESSAGE_DUE}) ` +
        `OR ("conversation_id" = ${RETENTION_ID} AND ("encrypted_body" IS NULL OR ${MESSAGE_DUE})))`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_update" ON "conversation_messages" FOR UPDATE ` +
        `USING ("conversation_id" = ${RETENTION_ID} AND ${MESSAGE_DUE}) ` +
        `WITH CHECK ("conversation_id" = ${RETENTION_ID} AND "encrypted_body" IS NULL AND "deleted_at" IS NOT NULL)`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_usage_reconcile_read" ON "conversation_messages" FOR SELECT ` +
        `USING (${parentInSpace('conversation_messages')})`,
    );

    // --- attachments
    await this.childRead(
      queryRunner,
      'conversation_attachments',
      ATTACHMENT_READ_AFTER,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_read" ON "conversation_attachments" FOR SELECT ` +
        `USING ((${RETENTION_SCAN} AND ${ATTACHMENT_DUE}) ` +
        `OR ("conversation_id" = ${RETENTION_ID} AND ("status" = 'purged' OR ${ATTACHMENT_DUE})))`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_update" ON "conversation_attachments" FOR UPDATE ` +
        `USING ("conversation_id" = ${RETENTION_ID} AND ${ATTACHMENT_DUE}) ` +
        `WITH CHECK ("conversation_id" = ${RETENTION_ID} AND "status" = 'purged' AND "deleted_at" IS NOT NULL)`,
    );

    // --- usage counters (written by the triggers of the rows above)
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_usage" ON "conversation_space_usage" FOR ALL ` +
        `USING (${spaceOfPurged('conversation_space_usage')}) WITH CHECK (${spaceOfPurged('conversation_space_usage')})`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_retention_usage" ON "conversation_attachment_usage" FOR ALL ` +
        `USING (${spaceOfPurged('conversation_attachment_usage')}) WITH CHECK (${spaceOfPurged('conversation_attachment_usage')})`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_usage_reconcile_scan" ON "conversation_space_usage" FOR SELECT ` +
        `USING (${RECONCILE_SCAN})`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_usage_reconcile_write" ON "conversation_space_usage" FOR ALL ` +
        `USING ("space_id" = ${RECONCILE_ID}) WITH CHECK ("space_id" = ${RECONCILE_ID})`,
    );
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION conversation_usage_refuse_direct_write() RETURNS trigger LANGUAGE plpgsql AS $$${GUARD_AFTER}$$`,
    );

    // --- hub registry
    for (const table of HUB_REGISTRY_TABLES) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `CREATE POLICY "${table}_read" ON "${table}" FOR SELECT USING (true)`,
      );
      await queryRunner.query(
        `CREATE POLICY "${table}_insert" ON "${table}" FOR INSERT WITH CHECK (true)`,
      );
      await queryRunner.query(
        `CREATE POLICY "${table}_update" ON "${table}" FOR UPDATE USING (true) WITH CHECK (true)`,
      );
      await queryRunner.query(
        `CREATE POLICY "${table}_cleanup_delete" ON "${table}" FOR DELETE ` +
          `USING (${HUB_CLEANUP} AND "expires_at" < ${CUTOFF})`,
      );
      await queryRunner.query(`GRANT DELETE ON "${table}" TO app_runtime`);
    }

    // --- agent issued proposals
    await queryRunner.query(
      `CREATE POLICY "agent_proposal_retention" ON "agent_issued_proposals" FOR SELECT ` +
        `USING (${PROPOSAL_RETENTION} AND "created_at" < ${CUTOFF})`,
    );
    await queryRunner.query(
      `CREATE POLICY "agent_proposal_retention_delete" ON "agent_issued_proposals" FOR DELETE ` +
        `USING (${PROPOSAL_RETENTION} AND "created_at" < ${CUTOFF})`,
    );
    await queryRunner.query(
      `GRANT DELETE ON "agent_issued_proposals" TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `REVOKE DELETE ON "agent_issued_proposals" FROM app_runtime`,
    );
    await queryRunner.query(
      `DROP POLICY "agent_proposal_retention_delete" ON "agent_issued_proposals"`,
    );
    await queryRunner.query(
      `DROP POLICY "agent_proposal_retention" ON "agent_issued_proposals"`,
    );
    for (const table of HUB_REGISTRY_TABLES) {
      await queryRunner.query(`REVOKE DELETE ON "${table}" FROM app_runtime`);
      for (const suffix of ['cleanup_delete', 'update', 'insert', 'read']) {
        await queryRunner.query(
          `DROP POLICY "${table}_${suffix}" ON "${table}"`,
        );
      }
      await queryRunner.query(
        `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`,
      );
    }
    await queryRunner.query(
      `CREATE OR REPLACE FUNCTION conversation_usage_refuse_direct_write() RETURNS trigger LANGUAGE plpgsql AS $$${GUARD_BEFORE}$$`,
    );
    for (const [table, policy] of [
      ['conversation_space_usage', 'conversation_usage_reconcile_write'],
      ['conversation_space_usage', 'conversation_usage_reconcile_scan'],
      ['conversation_attachment_usage', 'conversation_retention_usage'],
      ['conversation_space_usage', 'conversation_retention_usage'],
      ['conversation_attachments', 'conversation_retention_update'],
      ['conversation_attachments', 'conversation_retention_read'],
      ['conversation_messages', 'conversation_usage_reconcile_read'],
      ['conversation_messages', 'conversation_retention_update'],
      ['conversation_messages', 'conversation_retention_read'],
      ['conversations', 'conversation_usage_reconcile_read'],
      ['conversations', 'conversation_retention_update'],
      ['conversations', 'conversation_retention_read'],
    ] as const) {
      await queryRunner.query(`DROP POLICY "${policy}" ON "${table}"`);
    }
    await this.childRead(
      queryRunner,
      'conversation_attachments',
      ATTACHMENT_READ_BEFORE,
    );
    await this.childRead(
      queryRunner,
      'conversation_messages',
      MESSAGE_READ_BEFORE,
    );
    await this.conversationPolicies(queryRunner, ACCESS, ACCESS);
  }

  // The restrictive SELECT/UPDATE policies of `conversations`, with the commit-time escape and the original expression
  // kept in the COMMENT (as ConversationCloudReserve).
  private async conversationPolicies(
    qr: QueryRunner,
    read: string,
    update: string,
  ): Promise<void> {
    await qr.query(
      `ALTER POLICY "conversation_read" ON "conversations" USING (${ESCAPE} OR ${read})`,
    );
    await qr.query(
      `ALTER POLICY "conversation_update" ON "conversations" USING (${ESCAPE} OR ${update}) WITH CHECK (${ESCAPE} OR true)`,
    );
    for (const [name, qual, withCheck] of [
      ['conversation_read', read, null],
      ['conversation_update', update, 'true'],
    ] as const) {
      const original =
        ORIGINAL_POLICY_PREFIX + JSON.stringify({ qual, withCheck });
      await qr.query(
        `COMMENT ON POLICY "${name}" ON "conversations" IS '${original.replaceAll("'", "''")}'`,
      );
    }
  }

  private async childRead(qr: QueryRunner, table: string, using: string) {
    await qr.query(`DROP POLICY "conversation_child_read" ON "${table}"`);
    await qr.query(
      `CREATE POLICY "conversation_child_read" ON "${table}" AS RESTRICTIVE FOR SELECT USING ${using}`,
    );
  }
}
