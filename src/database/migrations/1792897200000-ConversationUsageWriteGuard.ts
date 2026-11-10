import { MigrationInterface, QueryRunner } from 'typeorm';

const TABLES = [
  'conversation_space_usage',
  'conversation_attachment_usage',
] as const;

// Os contadores de uso dos assuntos (`conversation_space_usage`, `conversation_attachment_usage`) só mudam pelos
// triggers de mensagens, anexos e cabeçalho. Tirar o INSERT/UPDATE do `app_runtime` não dá: os triggers são SECURITY
// INVOKER (sem SECURITY DEFINER, a regra do projeto) e gravam com o papel de quem escreve a mensagem. Em vez disso, um
// BEFORE INSERT/UPDATE recusa (42501) a escrita feita FORA de um trigger (`pg_trigger_depth() < 2`: o próprio guarda
// está no nível 1 numa escrita direta e no 2 ou mais quando quem grava é outro trigger). Papel que ignora o RLS
// (superusuário ou BYPASSRLS: o dono nas migrations e no CLI de retenção, e os testes que forjam um espaço cheio) pode
// escrever direto, para manutenção. O runtime não tem DELETE nessas tabelas.
export class ConversationUsageWriteGuard1792897200000 implements MigrationInterface {
  name = 'ConversationUsageWriteGuard1792897200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION conversation_usage_refuse_direct_write() RETURNS trigger AS $$
      BEGIN
        IF pg_trigger_depth() < 2 AND NOT EXISTS (
          SELECT 1 FROM pg_roles WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
        ) THEN
          RAISE EXCEPTION '% is maintained only by the conversation triggers', TG_TABLE_NAME
            USING ERRCODE = 'insufficient_privilege';
        END IF;
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    for (const table of TABLES) {
      await queryRunner.query(
        `CREATE TRIGGER "trg_${table}_guard" BEFORE INSERT OR UPDATE ON "${table}" ` +
          `FOR EACH ROW EXECUTE FUNCTION conversation_usage_refuse_direct_write()`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of TABLES) {
      await queryRunner.query(
        `DROP TRIGGER "trg_${table}_guard" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP FUNCTION conversation_usage_refuse_direct_write()`,
    );
  }
}
