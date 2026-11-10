import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableOrganizationRls } from '../../shared/infra/db/migration-helpers.js';

const RECONCILE = `current_setting('app.storage_reconcile', true) = 'on'`;
const VISIBLE = `EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.id = conversation_attachments.conversation_id AND c.organization_id = conversation_attachments.organization_id)`;
const MARKED = `"s3_write_started_at" IS NOT NULL`;

const IMMUTABLE_BEFORE = ['organization_id', 'conversation_id', 'key_version'];
const IMMUTABLE_AFTER = [
  ...IMMUTABLE_BEFORE,
  'space_id',
  'uploaded_by_user_id',
  'uploaded_by_hub_id',
  'size_bytes',
  'sha256',
];

// Anexos dos assuntos no bucket do storage (spec conversations §4.4; Task 5 do plano):
// - `conversation_attachments` ganha `space_id` (parte da chave no S3; o trigger BEFORE INSERT
//   `trg_conversation_attachments_space` preenche a partir da conversa, ou recusa um valor diferente) e quem pediu o
//   envio (`uploaded_by_user_id` / `uploaded_by_hub_id`, exatamente um; só ele confirma). Identidade imutável também
//   para essas colunas, o tamanho e o sha256.
// - Reparo (mesmo diário do backup): a varredura `storage:reconcile` precisa ler e travar as linhas MARCADAS
//   (`s3_write_started_at`) sem ser participante. Mesma chave de confiança do backup (`app.storage_reconcile = 'on'`, só
//   o backend): policy permissiva `conversation_attachment_reconcile_read` (SELECT das linhas marcadas, de qualquer
//   organização, para achar os candidatos). Nas restritivas: UPDATE (e FOR UPDATE) só da linha MARCADA nesse contexto
//   (o reparo trava a linha no escopo da organização dela e limpa a marca); SELECT e o WITH CHECK do UPDATE aceitam o
//   contexto sem exigir a marca, porque limpar a marca é um UPDATE com WHERE, e o Postgres confere a linha NOVA (já sem
//   marca) contra as policies de SELECT. Sem organização no contexto, o permissivo só deixa ver as marcadas; com ela,
//   o contexto do reparo lê os metadados dos anexos da organização (ids, tamanho, sha256, versão do S3; os repositórios
//   só pedem por id), nunca a conversa, mensagens ou cópias.
// - Uso do espaço: projeção `conversation_attachment_usage` (uma linha por anexo, RLS só da organização), mantida só pelo
//   trigger AFTER `trg_conversation_attachments_space_usage` (INSERT e UPDATE de status/lápide/janela): `stored` =
//   confirmado (sai em `purged`), `trash` = confirmado com lápide, `reserved_until` = janela da intenção pendente viva.
//   Uso = SUM(size) de `stored` ou `reserved_until > now()`; lixeira = SUM de `trash`. Uma linha por anexo e não um
//   contador porque a reserva vence no tempo. Serialização (conferir DEPOIS de gravar, como as mensagens): quando o anexo
//   pode aumentar o uso (INSERT, janela estendida), o trigger trava a linha do espaço em `conversation_space_usage`
//   (a mesma que o trigger das mensagens atualiza): duas intenções/envios do mesmo espaço se serializam ali e o segundo
//   lê o primeiro. Limpar a marca (varredura) não dispara o trigger (coluna fora da lista).
export class ConversationAttachmentStorage1792896700000 implements MigrationInterface {
  name = 'ConversationAttachmentStorage1792896700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_attachments" ADD "space_id" uuid, ADD "uploaded_by_user_id" uuid, ADD "uploaded_by_hub_id" uuid`,
    );
    // Linhas anteriores (nenhuma rota as criava): o espaço da conversa e o dono como quem enviou.
    await queryRunner.query(`
      UPDATE "conversation_attachments" a
         SET space_id = c.space_id, uploaded_by_user_id = c.owner_user_id
        FROM conversations c
       WHERE c.id = a.conversation_id AND c.organization_id = a.organization_id
    `);
    await queryRunner.query(
      `ALTER TABLE "conversation_attachments" ALTER COLUMN "space_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_attachments" ADD CONSTRAINT "ck_conversation_attachments_uploader" CHECK (num_nonnulls("uploaded_by_user_id", "uploaded_by_hub_id") = 1)`,
    );
    for (const [name, column] of [
      ['fk_conversation_attachments_spaces_idx', 'space_id'],
      [
        'fk_conversation_attachments_uploaded_by_users_idx',
        'uploaded_by_user_id',
      ],
      [
        'fk_conversation_attachments_uploaded_by_hubs_idx',
        'uploaded_by_hub_id',
      ],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "conversation_attachments" ("${column}")`,
      );
    }
    for (const sql of [
      `ALTER TABLE "conversation_attachments" ADD CONSTRAINT "fk_conversation_attachments_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces" ("id", "organization_id")`,
      `ALTER TABLE "conversation_attachments" ADD CONSTRAINT "fk_conversation_attachments_uploaded_by_users" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users" ("id")`,
      `ALTER TABLE "conversation_attachments" ADD CONSTRAINT "fk_conversation_attachments_uploaded_by_hubs" FOREIGN KEY ("uploaded_by_hub_id") REFERENCES "hubs" ("id")`,
    ]) {
      await queryRunner.query(sql);
    }

    await queryRunner.query(`
      CREATE FUNCTION conversation_attachments_space() RETURNS trigger AS $$
      DECLARE
        conversation_space uuid;
      BEGIN
        SELECT c.space_id INTO conversation_space FROM conversations c
         WHERE c.id = NEW.conversation_id AND c.organization_id = NEW.organization_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'conversation % is not visible while adding an attachment', NEW.conversation_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        IF NEW.space_id IS NULL THEN
          NEW.space_id := conversation_space;
        ELSIF NEW.space_id <> conversation_space THEN
          RAISE EXCEPTION 'conversation_attachments.space_id must be the space of the conversation'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversation_attachments_space" BEFORE INSERT ON "conversation_attachments" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_attachments_space()`,
    );
    await this.immutable(queryRunner, IMMUTABLE_AFTER);

    // Reparo pela varredura (contexto de confiança do backend, só linhas marcadas).
    await queryRunner.query(
      `CREATE POLICY "conversation_attachment_reconcile_read" ON "conversation_attachments" FOR SELECT ` +
        `USING (${RECONCILE} AND ${MARKED})`,
    );
    await this.restrictive(
      queryRunner,
      `(${VISIBLE} OR ${RECONCILE})`,
      `(${VISIBLE} OR (${RECONCILE} AND ${MARKED}))`,
      `(${VISIBLE} OR ${RECONCILE})`,
    );

    await queryRunner.query(`
      CREATE TABLE "conversation_attachment_usage" (
        "attachment_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "organization_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "size_bytes" bigint NOT NULL,
        "stored" boolean NOT NULL DEFAULT false,
        "trash" boolean NOT NULL DEFAULT false,
        "reserved_until" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_conversation_attachment_usage" PRIMARY KEY ("attachment_id"),
        CONSTRAINT "ck_conversation_attachment_usage_size_bytes" CHECK ("size_bytes" > 0),
        CONSTRAINT "ck_conversation_attachment_usage_trash" CHECK (NOT "trash" OR "stored"),
        CONSTRAINT "ck_conversation_attachment_usage_reserved" CHECK (NOT ("stored" AND "reserved_until" IS NOT NULL))
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_conversation_attachment_usage_space" ON "conversation_attachment_usage" ("organization_id", "space_id")`,
    );
    for (const sql of [
      `ALTER TABLE "conversation_attachment_usage" ADD CONSTRAINT "fk_conversation_attachment_usage_attachments" FOREIGN KEY ("attachment_id") REFERENCES "conversation_attachments" ("id")`,
      `ALTER TABLE "conversation_attachment_usage" ADD CONSTRAINT "fk_conversation_attachment_usage_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "conversation_attachment_usage" ADD CONSTRAINT "fk_conversation_attachment_usage_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces" ("id", "organization_id")`,
    ]) {
      await queryRunner.query(sql);
    }
    await enableOrganizationRls(queryRunner, 'conversation_attachment_usage');

    await queryRunner.query(`
      CREATE FUNCTION conversation_attachments_space_usage() RETURNS trigger AS $$
      DECLARE
        is_stored boolean := NEW.status = 'committed';
        is_trash boolean := NEW.status = 'committed' AND NEW.deleted_at IS NOT NULL;
        reserved timestamptz := CASE WHEN NEW.status = 'pending' AND NEW.deleted_at IS NULL
                                     THEN NEW.upload_expires_at END;
      BEGIN
        INSERT INTO conversation_attachment_usage
               (attachment_id, organization_id, space_id, size_bytes, stored, trash, reserved_until)
        VALUES (NEW.id, NEW.organization_id, NEW.space_id, NEW.size_bytes, is_stored, is_trash, reserved)
        ON CONFLICT (attachment_id) DO UPDATE
           SET stored = EXCLUDED.stored, trash = EXCLUDED.trash, reserved_until = EXCLUDED.reserved_until,
               updated_at = now();
        -- Pode aumentar o uso: trava a linha do espaço no contador (a mesma das mensagens) até o COMMIT, para quem
        -- confere o uso depois de gravar ler os envios concorrentes do mesmo espaço.
        IF TG_OP = 'INSERT' OR NEW.upload_expires_at > OLD.upload_expires_at THEN
          INSERT INTO conversation_space_usage (space_id, organization_id)
               VALUES (NEW.space_id, NEW.organization_id)
          ON CONFLICT (space_id) DO NOTHING;
          PERFORM 1 FROM conversation_space_usage
            WHERE space_id = NEW.space_id AND organization_id = NEW.organization_id
              FOR UPDATE;
        END IF;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversation_attachments_space_usage" ` +
        `AFTER INSERT OR UPDATE OF "status", "deleted_at", "upload_expires_at" ON "conversation_attachments" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_attachments_space_usage()`,
    );
    await queryRunner.query(`
      INSERT INTO conversation_attachment_usage
             (attachment_id, organization_id, space_id, size_bytes, stored, trash, reserved_until)
      SELECT id, organization_id, space_id, size_bytes, status = 'committed',
             status = 'committed' AND deleted_at IS NOT NULL,
             CASE WHEN status = 'pending' AND deleted_at IS NULL THEN upload_expires_at END
        FROM conversation_attachments
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_conversation_attachments_space_usage" ON "conversation_attachments"`,
    );
    await queryRunner.query(
      `DROP FUNCTION conversation_attachments_space_usage()`,
    );
    await queryRunner.query(`DROP TABLE "conversation_attachment_usage"`);
    await this.restrictive(
      queryRunner,
      `(${VISIBLE})`,
      `(${VISIBLE})`,
      `(${VISIBLE})`,
    );
    await queryRunner.query(
      `DROP POLICY "conversation_attachment_reconcile_read" ON "conversation_attachments"`,
    );
    await this.immutable(queryRunner, IMMUTABLE_BEFORE);
    await queryRunner.query(
      `DROP TRIGGER "trg_conversation_attachments_space" ON "conversation_attachments"`,
    );
    await queryRunner.query(`DROP FUNCTION conversation_attachments_space()`);
    for (const fk of [
      'fk_conversation_attachments_uploaded_by_hubs',
      'fk_conversation_attachments_uploaded_by_users',
      'fk_conversation_attachments_spaces',
    ]) {
      await queryRunner.query(
        `ALTER TABLE "conversation_attachments" DROP CONSTRAINT "${fk}"`,
      );
    }
    for (const ix of [
      'fk_conversation_attachments_uploaded_by_hubs_idx',
      'fk_conversation_attachments_uploaded_by_users_idx',
      'fk_conversation_attachments_spaces_idx',
    ]) {
      await queryRunner.query(`DROP INDEX "${ix}"`);
    }
    await queryRunner.query(
      `ALTER TABLE "conversation_attachments" DROP CONSTRAINT "ck_conversation_attachments_uploader"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_attachments" DROP COLUMN "uploaded_by_hub_id", DROP COLUMN "uploaded_by_user_id", DROP COLUMN "space_id"`,
    );
  }

  private async immutable(qr: QueryRunner, columns: string[]): Promise<void> {
    await qr.query(
      `DROP TRIGGER "trg_conversation_attachments_immutable" ON "conversation_attachments"`,
    );
    await qr.query(
      `CREATE TRIGGER "trg_conversation_attachments_immutable" BEFORE UPDATE ON "conversation_attachments" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_rows_immutable(${columns.map((c) => `'${c}'`).join(', ')})`,
    );
  }

  private async restrictive(
    qr: QueryRunner,
    read: string,
    updateUsing: string,
    updateCheck: string,
  ): Promise<void> {
    await qr.query(
      `DROP POLICY "conversation_child_read" ON "conversation_attachments"`,
    );
    await qr.query(
      `DROP POLICY "conversation_child_update" ON "conversation_attachments"`,
    );
    await qr.query(
      `CREATE POLICY "conversation_child_read" ON "conversation_attachments" AS RESTRICTIVE FOR SELECT USING ${read}`,
    );
    await qr.query(
      `CREATE POLICY "conversation_child_update" ON "conversation_attachments" AS RESTRICTIVE FOR UPDATE ` +
        `USING ${updateUsing} WITH CHECK ${updateCheck}`,
    );
  }
}
