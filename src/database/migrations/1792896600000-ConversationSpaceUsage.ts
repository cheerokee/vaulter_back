import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableOrganizationRls } from '../../shared/infra/db/migration-helpers.js';

// A parte dos assuntos no uso do espaço (spec conversations §4.4.1: o texto das mensagens conta no uso, como os
// anexos). Um contador por espaço, `conversation_space_usage`, mantido só pelo trigger AFTER INSERT/UPDATE em
// `conversation_messages`:
// - contribuição de uma linha: `body_bytes` se o corpo ainda está guardado (`encrypted_body` não nulo), e a mesma
//   quantia em `trash_bytes` se ela também tem lápide. O trigger soma (NOVA - VELHA) no contador; zerar o corpo
//   (retenção) tira os bytes do uso e da lixeira.
// - Por que um contador e não um SUM: as mensagens só são visíveis a participantes/executor (RLS); somá-las no contexto
//   de quem lê o uso (Gestor que redimensiona, intenção de envio do backup, GET do espaço) contaria só os assuntos dele.
//   O contador só tem o RLS da organização.
// - O espaço vem de `conversations`: quem grava a mensagem passou pela policy dela (a conversa visível), então a
//   conversa é visível dentro do trigger (SECURITY INVOKER, sem SECURITY DEFINER). Não achou: erro, nunca um uso errado.
// - Trava: o upsert segura a linha do contador do espaço até o COMMIT. O envio de mensagem trava o espaço FOR SHARE
//   antes (ordem espaço -> assunto -> contador), grava, e SÓ DEPOIS lê o uso e confere que cabe: dois envios do mesmo
//   espaço se serializam no contador (o segundo lê o primeiro), e a intenção de envio do backup (espaço FOR UPDATE)
//   espera os envios em andamento. Quem mexe em mensagens sem travar o espaço (apagar, retenção) nunca trava o espaço
//   DEPOIS do contador.
// - Preenche o contador com as mensagens que já existem.
export class ConversationSpaceUsage1792896600000 implements MigrationInterface {
  name = 'ConversationSpaceUsage1792896600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "conversation_space_usage" (
        "space_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "organization_id" uuid NOT NULL,
        "body_bytes" bigint NOT NULL DEFAULT '0',
        "trash_bytes" bigint NOT NULL DEFAULT '0',
        CONSTRAINT "PK_conversation_space_usage" PRIMARY KEY ("space_id"),
        CONSTRAINT "ck_conversation_space_usage_body_bytes" CHECK ("body_bytes" >= 0),
        CONSTRAINT "ck_conversation_space_usage_trash_bytes" CHECK ("trash_bytes" >= 0 AND "trash_bytes" <= "body_bytes")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_conversation_space_usage_organizations_idx" ON "conversation_space_usage" ("organization_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_space_usage" ADD CONSTRAINT "fk_conversation_space_usage_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_space_usage" ADD CONSTRAINT "fk_conversation_space_usage_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces" ("id", "organization_id")`,
    );
    await enableOrganizationRls(queryRunner, 'conversation_space_usage');

    await queryRunner.query(`
      CREATE FUNCTION conversation_messages_space_usage() RETURNS trigger AS $$
      DECLARE
        used_delta bigint;
        trash_delta bigint;
        target_space uuid;
      BEGIN
        used_delta := CASE WHEN NEW.encrypted_body IS NOT NULL THEN NEW.body_bytes ELSE 0 END;
        trash_delta := CASE WHEN NEW.encrypted_body IS NOT NULL AND NEW.deleted_at IS NOT NULL
                            THEN NEW.body_bytes ELSE 0 END;
        IF TG_OP = 'UPDATE' THEN
          used_delta := used_delta - CASE WHEN OLD.encrypted_body IS NOT NULL THEN OLD.body_bytes ELSE 0 END;
          trash_delta := trash_delta - CASE WHEN OLD.encrypted_body IS NOT NULL AND OLD.deleted_at IS NOT NULL
                                            THEN OLD.body_bytes ELSE 0 END;
        END IF;
        IF used_delta = 0 AND trash_delta = 0 THEN
          RETURN NULL;
        END IF;
        SELECT c.space_id INTO target_space FROM conversations c
         WHERE c.id = NEW.conversation_id AND c.organization_id = NEW.organization_id;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'conversation % is not visible while counting its space usage', NEW.conversation_id
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        -- A linha do espaço existe antes da soma: no INSERT ... ON CONFLICT DO UPDATE os CHECKs valem também para a
        -- linha proposta (só o delta), que pode ser negativa ou ter lixeira > corpo.
        INSERT INTO conversation_space_usage (space_id, organization_id)
             VALUES (target_space, NEW.organization_id)
        ON CONFLICT (space_id) DO NOTHING;
        UPDATE conversation_space_usage
           SET body_bytes = body_bytes + used_delta,
               trash_bytes = trash_bytes + trash_delta,
               updated_at = now()
         WHERE space_id = target_space AND organization_id = NEW.organization_id;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversation_messages_space_usage" ` +
        `AFTER INSERT OR UPDATE OF "encrypted_body", "deleted_at", "body_bytes" ON "conversation_messages" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_messages_space_usage()`,
    );

    await queryRunner.query(`
      INSERT INTO conversation_space_usage (space_id, organization_id, body_bytes, trash_bytes)
      SELECT c.space_id, c.organization_id,
             COALESCE(SUM(m.body_bytes) FILTER (WHERE m.encrypted_body IS NOT NULL), 0),
             COALESCE(SUM(m.body_bytes) FILTER (WHERE m.encrypted_body IS NOT NULL AND m.deleted_at IS NOT NULL), 0)
        FROM conversation_messages m
        JOIN conversations c ON c.id = m.conversation_id AND c.organization_id = m.organization_id
       GROUP BY c.space_id, c.organization_id
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_conversation_messages_space_usage" ON "conversation_messages"`,
    );
    await queryRunner.query(
      `DROP FUNCTION conversation_messages_space_usage()`,
    );
    await queryRunner.query(`DROP TABLE "conversation_space_usage"`);
  }
}
