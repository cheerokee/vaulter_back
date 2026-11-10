import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addSyncVersionTrigger,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

const STATES = `'aviso', 'trabalhando', 'na_fila', 'pede_sim', 'esperando_pc', 'concluido', 'arquivado'`;

// A conversa da linha está visível no contexto (a policy de `conversations` filtra a subconsulta).
const CONVERSATION_VISIBLE = (table: string) => `EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.id = ${table}.conversation_id AND c.organization_id = ${table}.organization_id)`;

const CHILD_TABLES = [
  'conversation_participants',
  'conversation_key_grants',
  'conversation_messages',
  'conversation_attachments',
] as const;

// Conversas (assuntos) como dado do espaço (spec 2026-11-09-conversations §4; módulo `conversations`).
// Cinco tabelas, todas com organization_id, FKs compostas (filho, organization_id) -> (pai.id, pai.organization_id) para
// espaço, conversa e mensagem (a checagem de FK ignora o RLS), timestamps, lápide e sync_version; o runtime fica com os
// default privileges (SELECT, INSERT, UPDATE; sem DELETE). O backend só vê metadado: ids, dono, executor, estado,
// horários, tamanhos, versões, ack. Título, plano, conteúdo, nome e tipo de anexo vivem em blobs cifrados.
// `moved_from_conversation_id` é só um link por id (pode apontar para outra organização), sem FK.
//
// RLS: org_isolation (permissiva, do helper) E policies RESTRITIVAS por comando, que exigem participante vivo
// (`app.user_id`) ou executor (`app.hub_id`). Sem SECURITY DEFINER; as policies só leem current_setting e tabelas pelo
// papel de quem consulta.
//
// | Tabela | SELECT | INSERT | UPDATE (USING / WITH CHECK) |
// |---|---|---|---|
// | conversations | app.user_id em participant_user_ids, ou executor_hub_id = app.hub_id | owner_user_id = app.user_id, ou executor_hub_id = app.hub_id | visível / true (ver "Quem sai") |
// | conversation_participants | a conversa visível, ou a própria linha (user_id = app.user_id) | a conversa visível | a conversa visível / a conversa visível |
// | conversation_key_grants | a conversa visível, ou a própria cópia (user_id = app.user_id ou hub_id = app.hub_id) | a conversa visível | idem |
// | conversation_messages, conversation_attachments | a conversa visível | a conversa visível | idem |
//
// - Sem recursão: a policy de `conversations` não consulta nenhuma tabela; ela lê `participant_user_ids`, cópia
//   DERIVADA dos participantes vivos (`conversation_participants`), mantida só pelo trigger
//   `conversation_participants_sync` (AFTER INSERT/UPDATE nas participações). As tabelas filhas consultam
//   `conversations` (com a policy dela) e nada consulta as filhas de volta. Uma policy de `conversations` que
//   consultasse `conversation_participants` daria recursão (a de participantes precisa da conversa para mostrar os
//   outros participantes).
// - `participant_user_ids` só muda pelo trigger: na criação o BEFORE INSERT põe [owner_user_id] (o dono é o primeiro
//   participante; o repositório grava a participação dele na mesma transação) e o BEFORE UPDATE recusa mudança feita
//   fora do trigger (pg_trigger_depth() < 2). Lista ordenada, sem repetição.
// - Própria linha visível depois de sair: a pessoa (ou o Hub) continua lendo só a PRÓPRIA participação e as PRÓPRIAS
//   cópias, já com lápide, para a sincronização dela saber que saiu e apagar o que tem localmente. Não lê mais a
//   conversa, as mensagens, os anexos nem os outros participantes. Quem nunca participou não vê nenhuma linha.
//   UPDATE da própria linha sem a conversa visível não passa (não dá para se reativar).
// - Quem sai: no UPDATE, o Postgres confere a linha NOVA contra as policies de SELECT quando o comando lê colunas
//   (WHERE/RETURNING). Por isso o trigger grava `participant_user_ids` com `WHERE CURRENT OF` num cursor `FOR UPDATE`
//   (o SET não lê colunas de `conversations`): quem tira a própria participação perde a conversa nesse mesmo
//   comando, sem erro. Todo o resto que quem sai grava na conversa (dono novo, executor, lápide da conversa, lápide das
//   próprias cópias) vem ANTES da lápide da participação: depois dela, a conversa some para essa pessoa. Por isso o
//   WITH CHECK do UPDATE de `conversations` é `true` (o USING já exige a conversa visível).
// - Escrita pelo contexto de quem é afetado: a saída de uma pessoa (do assunto ou do espaço) roda com o `app.user_id`
//   de quem sai. Hub que deixa de valer (executor_hub_id volta a nulo, lápide nas cópias do Hub) roda SEMPRE no contexto
//   de um PARTICIPANTE (`app.user_id`, ex.: o dono do Hub, que participa pela regra do executor, ou o dono do assunto),
//   NUNCA no `app.hub_id` do próprio Hub: com executor_hub_id nulo a linha nova não passa pela policy de SELECT do Hub
//   (42501), e as cópias dele deixam de ser graváveis por ele. Nunca um contexto "de confiança" que abra todas as
//   conversas. (Comentário corrigido depois, na migration ConversationsHardening; o SQL desta não mudou.)
// - Ordem de locks: conversa (`FOR UPDATE`, `lockById`) antes das participações; o trigger trava a conversa depois da
//   linha da participação, então quem mexe em participações sem travar a conversa antes arrisca deadlock.
export class CreateConversations1792896400000 implements MigrationInterface {
  name = 'CreateConversations1792896400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "conversations" (
        "id" uuid NOT NULL,${COMMON},
        "organization_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "created_by_user_id" uuid NOT NULL,
        "owner_user_id" uuid NOT NULL,
        "executor_hub_id" uuid,
        "state" character varying(20) NOT NULL,
        "last_message_at" TIMESTAMP WITH TIME ZONE,
        "current_key_version" integer NOT NULL DEFAULT 1,
        "key_rotation_required" boolean NOT NULL DEFAULT false,
        "encrypted_header" text,
        "header_key_version" integer,
        "moved_from_conversation_id" uuid,
        "participant_user_ids" uuid array NOT NULL,
        CONSTRAINT "PK_conversations" PRIMARY KEY ("id"),
        CONSTRAINT "uq_conversations_id_organization" UNIQUE ("id", "organization_id"),
        CONSTRAINT "ck_conversations_state" CHECK ("state" IN (${STATES})),
        CONSTRAINT "ck_conversations_current_key_version" CHECK ("current_key_version" >= 1),
        CONSTRAINT "ck_conversations_header" CHECK (("encrypted_header" IS NULL) = ("header_key_version" IS NULL)),
        CONSTRAINT "ck_conversations_header_key_version" CHECK ("header_key_version" >= 1 AND "header_key_version" <= "current_key_version"),
        CONSTRAINT "ck_conversations_header_length" CHECK (length("encrypted_header") <= 21846),
        CONSTRAINT "ck_conversations_moved_from" CHECK ("moved_from_conversation_id" <> "id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation_participants" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "joined_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_conversation_participants" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation_key_grants" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "key_version" integer NOT NULL,
        "user_id" uuid,
        "hub_id" uuid,
        "wrapped_key" character varying(108) NOT NULL,
        CONSTRAINT "PK_conversation_key_grants" PRIMARY KEY ("id"),
        CONSTRAINT "ck_conversation_key_grants_recipient" CHECK (num_nonnulls("user_id", "hub_id") = 1),
        CONSTRAINT "ck_conversation_key_grants_key_version" CHECK ("key_version" >= 1),
        CONSTRAINT "ck_conversation_key_grants_wrapped_key" CHECK ("wrapped_key" ~ '^[A-Za-z0-9_-]{108}$')
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation_messages" (
        "id" uuid NOT NULL,${COMMON},
        "organization_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "author_user_id" uuid,
        "author_hub_id" uuid,
        "key_version" integer NOT NULL,
        "encrypted_body" text,
        "body_bytes" integer NOT NULL,
        "replaces_message_id" uuid,
        "pending" boolean NOT NULL,
        "acked_at" TIMESTAMP WITH TIME ZONE,
        "sent_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_conversation_messages" PRIMARY KEY ("id"),
        CONSTRAINT "uq_conversation_messages_id_conversation" UNIQUE ("id", "conversation_id", "organization_id"),
        CONSTRAINT "ck_conversation_messages_author" CHECK (num_nonnulls("author_user_id", "author_hub_id") = 1),
        CONSTRAINT "ck_conversation_messages_key_version" CHECK ("key_version" >= 1),
        CONSTRAINT "ck_conversation_messages_body_bytes" CHECK ("body_bytes" BETWEEN 1 AND 65536),
        CONSTRAINT "ck_conversation_messages_body_length" CHECK (("encrypted_body" IS NULL) OR ((length("encrypted_body") * 3) / 4 = "body_bytes")),
        CONSTRAINT "ck_conversation_messages_body_retention" CHECK (("encrypted_body" IS NOT NULL) OR ("deleted_at" IS NOT NULL)),
        CONSTRAINT "ck_conversation_messages_pending" CHECK ("pending" = ("acked_at" IS NULL)),
        CONSTRAINT "ck_conversation_messages_hub_acked" CHECK (("author_hub_id" IS NULL) OR (NOT "pending")),
        CONSTRAINT "ck_conversation_messages_replaces" CHECK ("replaces_message_id" <> "id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "conversation_attachments" (
        "id" uuid NOT NULL,${COMMON},
        "organization_id" uuid NOT NULL,
        "conversation_id" uuid NOT NULL,
        "message_id" uuid,
        "key_version" integer NOT NULL,
        "size_bytes" bigint NOT NULL,
        "sha256" character(64) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "s3_version_id" character varying(1024),
        "s3_write_started_at" TIMESTAMP WITH TIME ZONE,
        "upload_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_conversation_attachments" PRIMARY KEY ("id"),
        CONSTRAINT "ck_conversation_attachments_status" CHECK ("status" IN ('pending', 'committed', 'purged')),
        CONSTRAINT "ck_conversation_attachments_size_bytes" CHECK ("size_bytes" BETWEEN 1 AND 104857600),
        CONSTRAINT "ck_conversation_attachments_key_version" CHECK ("key_version" >= 1),
        CONSTRAINT "ck_conversation_attachments_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "ck_conversation_attachments_committed" CHECK (("status" IN ('committed', 'purged')) = ("s3_version_id" IS NOT NULL))
      )
    `);

    for (const [table, name, columns, where] of [
      [
        'conversations',
        'fk_conversations_organizations_idx',
        '"organization_id"',
      ],
      ['conversations', 'fk_conversations_spaces_idx', '"space_id"'],
      [
        'conversations',
        'fk_conversations_created_by_idx',
        '"created_by_user_id"',
      ],
      ['conversations', 'fk_conversations_owner_idx', '"owner_user_id"'],
      [
        'conversations',
        'fk_conversations_executor_hub_idx',
        '"executor_hub_id"',
      ],
      [
        'conversation_participants',
        'fk_conversation_participants_organizations_idx',
        '"organization_id"',
      ],
      [
        'conversation_participants',
        'fk_conversation_participants_conversations_idx',
        '"conversation_id"',
      ],
      [
        'conversation_participants',
        'fk_conversation_participants_users_idx',
        '"user_id"',
      ],
      [
        'conversation_key_grants',
        'fk_conversation_key_grants_organizations_idx',
        '"organization_id"',
      ],
      [
        'conversation_key_grants',
        'fk_conversation_key_grants_conversations_idx',
        '"conversation_id"',
      ],
      [
        'conversation_key_grants',
        'fk_conversation_key_grants_users_idx',
        '"user_id"',
      ],
      [
        'conversation_key_grants',
        'fk_conversation_key_grants_hubs_idx',
        '"hub_id"',
      ],
      [
        'conversation_messages',
        'fk_conversation_messages_organizations_idx',
        '"organization_id"',
      ],
      [
        'conversation_messages',
        'fk_conversation_messages_conversations_idx',
        '"conversation_id"',
      ],
      [
        'conversation_messages',
        'fk_conversation_messages_author_users_idx',
        '"author_user_id"',
      ],
      [
        'conversation_messages',
        'fk_conversation_messages_author_hubs_idx',
        '"author_hub_id"',
      ],
      [
        'conversation_messages',
        'fk_conversation_messages_replaces_idx',
        '"replaces_message_id"',
      ],
      // Caixa de entrada: as pendentes vivas de uma conversa.
      [
        'conversation_messages',
        'ix_conversation_messages_pending',
        '"conversation_id"',
        `"pending" AND "deleted_at" IS NULL`,
      ],
      [
        'conversation_attachments',
        'fk_conversation_attachments_organizations_idx',
        '"organization_id"',
      ],
      [
        'conversation_attachments',
        'fk_conversation_attachments_conversations_idx',
        '"conversation_id"',
      ],
      [
        'conversation_attachments',
        'fk_conversation_attachments_messages_idx',
        '"message_id"',
      ],
      // Diário das gravações no S3 (a varredura do reparo procura as marcadas antigas).
      [
        'conversation_attachments',
        'ix_conversation_attachments_s3_write_started',
        '"s3_write_started_at"',
        `"s3_write_started_at" IS NOT NULL`,
      ],
    ] as const satisfies readonly (readonly [
      string,
      string,
      string,
      string?,
    ])[]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "${table}" (${columns})${where ? ` WHERE ${where}` : ''}`,
      );
    }
    // Uma participação viva por pessoa; uma cópia viva por (versão, destinatário).
    for (const sql of [
      `CREATE UNIQUE INDEX "uq_conversation_participants_live" ON "conversation_participants" ("conversation_id", "user_id") WHERE "deleted_at" IS NULL`,
      `CREATE UNIQUE INDEX "uq_conversation_key_grants_user" ON "conversation_key_grants" ("conversation_id", "key_version", "user_id") WHERE "user_id" IS NOT NULL AND "deleted_at" IS NULL`,
      `CREATE UNIQUE INDEX "uq_conversation_key_grants_hub" ON "conversation_key_grants" ("conversation_id", "key_version", "hub_id") WHERE "hub_id" IS NOT NULL AND "deleted_at" IS NULL`,
    ]) {
      await queryRunner.query(sql);
    }

    for (const sql of [
      `ALTER TABLE "conversations" ADD CONSTRAINT "fk_conversations_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "conversations" ADD CONSTRAINT "fk_conversations_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces" ("id", "organization_id")`,
      `ALTER TABLE "conversations" ADD CONSTRAINT "fk_conversations_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id")`,
      `ALTER TABLE "conversations" ADD CONSTRAINT "fk_conversations_owner" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id")`,
      `ALTER TABLE "conversations" ADD CONSTRAINT "fk_conversations_executor_hub" FOREIGN KEY ("executor_hub_id") REFERENCES "hubs" ("id")`,
      `ALTER TABLE "conversation_participants" ADD CONSTRAINT "fk_conversation_participants_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "conversation_participants" ADD CONSTRAINT "fk_conversation_participants_conversations" FOREIGN KEY ("conversation_id", "organization_id") REFERENCES "conversations" ("id", "organization_id")`,
      `ALTER TABLE "conversation_participants" ADD CONSTRAINT "fk_conversation_participants_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id")`,
      `ALTER TABLE "conversation_key_grants" ADD CONSTRAINT "fk_conversation_key_grants_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "conversation_key_grants" ADD CONSTRAINT "fk_conversation_key_grants_conversations" FOREIGN KEY ("conversation_id", "organization_id") REFERENCES "conversations" ("id", "organization_id")`,
      `ALTER TABLE "conversation_key_grants" ADD CONSTRAINT "fk_conversation_key_grants_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id")`,
      `ALTER TABLE "conversation_key_grants" ADD CONSTRAINT "fk_conversation_key_grants_hubs" FOREIGN KEY ("hub_id") REFERENCES "hubs" ("id")`,
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "fk_conversation_messages_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "fk_conversation_messages_conversations" FOREIGN KEY ("conversation_id", "organization_id") REFERENCES "conversations" ("id", "organization_id")`,
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "fk_conversation_messages_author_users" FOREIGN KEY ("author_user_id") REFERENCES "users" ("id")`,
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "fk_conversation_messages_author_hubs" FOREIGN KEY ("author_hub_id") REFERENCES "hubs" ("id")`,
      // A mensagem editada é da mesma conversa (e da mesma organização).
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "fk_conversation_messages_replaces" FOREIGN KEY ("replaces_message_id", "conversation_id", "organization_id") REFERENCES "conversation_messages" ("id", "conversation_id", "organization_id")`,
      `ALTER TABLE "conversation_attachments" ADD CONSTRAINT "fk_conversation_attachments_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "conversation_attachments" ADD CONSTRAINT "fk_conversation_attachments_conversations" FOREIGN KEY ("conversation_id", "organization_id") REFERENCES "conversations" ("id", "organization_id")`,
      // O anexo pertence a uma mensagem da mesma conversa.
      `ALTER TABLE "conversation_attachments" ADD CONSTRAINT "fk_conversation_attachments_messages" FOREIGN KEY ("message_id", "conversation_id", "organization_id") REFERENCES "conversation_messages" ("id", "conversation_id", "organization_id")`,
    ]) {
      await queryRunner.query(sql);
    }

    for (const table of ['conversations', ...CHILD_TABLES]) {
      await addSyncVersionTrigger(queryRunner, table);
      await enableOrganizationRls(queryRunner, table);
    }

    // participant_user_ids: derivado das participações vivas (veja o cabeçalho).
    await queryRunner.query(`
      CREATE FUNCTION conversations_guard_participants() RETURNS trigger AS $$
      BEGIN
        IF TG_OP = 'INSERT' THEN
          NEW.participant_user_ids := ARRAY[NEW.owner_user_id];
        ELSIF NEW.participant_user_ids IS DISTINCT FROM OLD.participant_user_ids AND pg_trigger_depth() < 2 THEN
          RAISE EXCEPTION 'conversations.participant_user_ids is derived from conversation_participants'
            USING ERRCODE = 'check_violation';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversations_guard_participants" BEFORE INSERT OR UPDATE ON "conversations" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversations_guard_participants()`,
    );
    await queryRunner.query(`
      CREATE FUNCTION conversation_participants_sync() RETURNS trigger AS $$
      DECLARE
        target CURSOR (cid uuid, oid uuid) FOR
          SELECT participant_user_ids FROM conversations
           WHERE id = cid AND organization_id = oid
             FOR UPDATE;
        current_ids uuid[];
        live_ids uuid[];
      BEGIN
        OPEN target(NEW.conversation_id, NEW.organization_id);
        FETCH target INTO current_ids;
        IF NOT FOUND THEN
          CLOSE target;
          RAISE EXCEPTION 'conversation % is not visible while changing its participants', NEW.conversation_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        SELECT COALESCE(array_agg(DISTINCT p.user_id ORDER BY p.user_id), '{}')
          INTO live_ids
          FROM conversation_participants p
         WHERE p.conversation_id = NEW.conversation_id
           AND p.organization_id = NEW.organization_id
           AND p.deleted_at IS NULL;
        IF live_ids IS DISTINCT FROM current_ids THEN
          -- WHERE CURRENT OF: o SET não lê colunas de conversations, então a linha nova não passa pela policy de
          -- SELECT (quem sai perde a conversa aqui, sem erro). Veja o cabeçalho da migration.
          UPDATE conversations SET participant_user_ids = live_ids, updated_at = now() WHERE CURRENT OF target;
        END IF;
        CLOSE target;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversation_participants_sync" AFTER INSERT OR UPDATE ON "conversation_participants" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_participants_sync()`,
    );

    // Policies restritivas (AND com a org_isolation).
    const conversationAccess = `(${USER} = ANY ("participant_user_ids") OR "executor_hub_id" = ${HUB})`;
    for (const sql of [
      `CREATE POLICY "conversation_read" ON "conversations" AS RESTRICTIVE FOR SELECT USING ${conversationAccess}`,
      `CREATE POLICY "conversation_insert" ON "conversations" AS RESTRICTIVE FOR INSERT
         WITH CHECK ("owner_user_id" = ${USER} OR "executor_hub_id" = ${HUB})`,
      `CREATE POLICY "conversation_update" ON "conversations" AS RESTRICTIVE FOR UPDATE
         USING ${conversationAccess} WITH CHECK (true)`,
    ]) {
      await queryRunner.query(sql);
    }
    const ownRow: Record<(typeof CHILD_TABLES)[number], string | null> = {
      conversation_participants: `"user_id" = ${USER}`,
      conversation_key_grants: `"user_id" = ${USER} OR "hub_id" = ${HUB}`,
      conversation_messages: null,
      conversation_attachments: null,
    };
    for (const table of CHILD_TABLES) {
      const visible = CONVERSATION_VISIBLE(table);
      const own = ownRow[table];
      const read = own ? `((${own}) OR ${visible})` : `(${visible})`;
      await queryRunner.query(
        `CREATE POLICY "conversation_child_read" ON "${table}" AS RESTRICTIVE FOR SELECT USING ${read}`,
      );
      await queryRunner.query(
        `CREATE POLICY "conversation_child_insert" ON "${table}" AS RESTRICTIVE FOR INSERT WITH CHECK (${visible})`,
      );
      await queryRunner.query(
        `CREATE POLICY "conversation_child_update" ON "${table}" AS RESTRICTIVE FOR UPDATE USING (${visible}) WITH CHECK (${visible})`,
      );
    }
  }

  // Derrubar as tabelas leva as policies, os índices e os triggers delas.
  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of [...CHILD_TABLES].reverse()) {
      await queryRunner.query(`DROP TABLE "${table}"`);
    }
    await queryRunner.query(`DROP TABLE "conversations"`);
    await queryRunner.query(`DROP FUNCTION conversation_participants_sync()`);
    await queryRunner.query(`DROP FUNCTION conversations_guard_participants()`);
  }
}
