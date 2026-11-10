import { MigrationInterface, QueryRunner } from 'typeorm';

const HEADER_BYTES = (col: string) => `COALESCE((length(${col}) * 3) / 4, 0)`;

// O cabeçalho cifrado do assunto conta no uso do espaço, como o corpo das mensagens (spec conversations §4.4.1;
// mesma disciplina do contador `conversation_space_usage`, migration ConversationSpaceUsage): o trigger AFTER INSERT /
// UPDATE OF `encrypted_header` em `conversations` soma (NOVO - VELHO) em `body_bytes` (o "usado" do contador). O
// cabeçalho de um assunto com lápide conta como usado (não lixeira) até a retenção zerá-lo, como as mensagens de um
// assunto com lápide. Bytes = o blob decodificado (base64url sem padding: floor(len * 3 / 4)). O espaço vem da própria
// linha. Quem cria ou troca o cabeçalho trava o espaço FOR SHARE antes (criar, `PUT .../header`), grava (o trigger
// trava a linha do contador) e SÓ DEPOIS confere o uso (422 `space-storage-full`). Preenche o contador com os
// cabeçalhos que já existem.
export class ConversationHeaderUsage1792897100000 implements MigrationInterface {
  name = 'ConversationHeaderUsage1792897100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION conversations_header_space_usage() RETURNS trigger AS $$
      DECLARE
        delta bigint := ${HEADER_BYTES('NEW.encrypted_header')};
      BEGIN
        IF TG_OP = 'UPDATE' THEN
          delta := delta - ${HEADER_BYTES('OLD.encrypted_header')};
        END IF;
        IF delta = 0 THEN
          RETURN NULL;
        END IF;
        INSERT INTO conversation_space_usage (space_id, organization_id)
             VALUES (NEW.space_id, NEW.organization_id)
        ON CONFLICT (space_id) DO NOTHING;
        UPDATE conversation_space_usage
           SET body_bytes = body_bytes + delta, updated_at = now()
         WHERE space_id = NEW.space_id AND organization_id = NEW.organization_id;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversations_header_space_usage" ` +
        `AFTER INSERT OR UPDATE OF "encrypted_header" ON "conversations" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversations_header_space_usage()`,
    );
    await queryRunner.query(`
      INSERT INTO conversation_space_usage (space_id, organization_id, body_bytes)
      SELECT space_id, organization_id, SUM(${HEADER_BYTES('encrypted_header')})
        FROM conversations
       WHERE encrypted_header IS NOT NULL
       GROUP BY space_id, organization_id
      ON CONFLICT (space_id) DO UPDATE
         SET body_bytes = conversation_space_usage.body_bytes + EXCLUDED.body_bytes, updated_at = now()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP TRIGGER "trg_conversations_header_space_usage" ON "conversations"`,
    );
    await queryRunner.query(`DROP FUNCTION conversations_header_space_usage()`);
    await queryRunner.query(`
      UPDATE conversation_space_usage u
         SET body_bytes = u.body_bytes - h.bytes, updated_at = now()
        FROM (SELECT space_id, SUM(${HEADER_BYTES('encrypted_header')}) AS bytes
                FROM conversations WHERE encrypted_header IS NOT NULL GROUP BY space_id) h
       WHERE u.space_id = h.space_id
    `);
  }
}
