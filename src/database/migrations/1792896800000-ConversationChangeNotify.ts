import { MigrationInterface, QueryRunner } from 'typeorm';

const CHANNEL = 'conversation_changes';
const CHILD_TABLES = [
  'conversation_participants',
  'conversation_messages',
  'conversation_attachments',
] as const;

// Sinal da sondagem longa do executor (spec conversations §4.6; `SyncConversationsUseCase`): toda gravação que muda o
// que um Hub executor vê manda `pg_notify('conversation_changes', <hub_id>)`. O Postgres só entrega a notificação no
// COMMIT (e descarta as repetidas da mesma transação), então o Hub acorda depois que a mudança já está visível.
// - `conversations`: o executor da linha nova e, se mudou, o anterior (ele recebe as lápides das próprias cópias);
// - `conversation_key_grants`: a cópia de um Hub avisa esse Hub; a de uma pessoa, o executor do assunto;
// - participações, mensagens e anexos: o executor do assunto, lido de `conversations` com o RLS de quem grava
//   (SECURITY INVOKER; quem grava passou pela policy da conversa). Não achou (ex.: a pessoa acabou de sair): nada a
//   avisar por esta linha; a saída já mudou a própria conversa, que avisa.
// O sinal é só uma dica: a API sempre relê por `sync_version`, então uma notificação perdida só atrasa a mudança até a
// próxima releitura. Uma conexão LISTEN por processo (`PgConversationChangeSignal`), nunca uma por pedido.
export class ConversationChangeNotify1792896800000 implements MigrationInterface {
  name = 'ConversationChangeNotify1792896800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE FUNCTION conversations_notify_executor() RETURNS trigger AS $$
      BEGIN
        IF NEW.executor_hub_id IS NOT NULL THEN
          PERFORM pg_notify('${CHANNEL}', NEW.executor_hub_id::text);
        END IF;
        IF TG_OP = 'UPDATE' AND OLD.executor_hub_id IS NOT NULL
           AND OLD.executor_hub_id IS DISTINCT FROM NEW.executor_hub_id THEN
          PERFORM pg_notify('${CHANNEL}', OLD.executor_hub_id::text);
        END IF;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(`
      CREATE FUNCTION conversation_child_notify_executor() RETURNS trigger AS $$
      DECLARE
        hub uuid;
      BEGIN
        SELECT c.executor_hub_id INTO hub FROM conversations c
         WHERE c.id = NEW.conversation_id AND c.organization_id = NEW.organization_id;
        IF hub IS NOT NULL THEN
          PERFORM pg_notify('${CHANNEL}', hub::text);
        END IF;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(`
      CREATE FUNCTION conversation_key_grants_notify_executor() RETURNS trigger AS $$
      DECLARE
        hub uuid;
      BEGIN
        IF NEW.hub_id IS NOT NULL THEN
          PERFORM pg_notify('${CHANNEL}', NEW.hub_id::text);
          RETURN NULL;
        END IF;
        SELECT c.executor_hub_id INTO hub FROM conversations c
         WHERE c.id = NEW.conversation_id AND c.organization_id = NEW.organization_id;
        IF hub IS NOT NULL THEN
          PERFORM pg_notify('${CHANNEL}', hub::text);
        END IF;
        RETURN NULL;
      END
      $$ LANGUAGE plpgsql SECURITY INVOKER
    `);
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversations_notify_executor" AFTER INSERT OR UPDATE ON "conversations" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversations_notify_executor()`,
    );
    await queryRunner.query(
      `CREATE TRIGGER "trg_conversation_key_grants_notify_executor" AFTER INSERT OR UPDATE ON "conversation_key_grants" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_key_grants_notify_executor()`,
    );
    for (const table of CHILD_TABLES) {
      await queryRunner.query(
        `CREATE TRIGGER "trg_${table}_notify_executor" AFTER INSERT OR UPDATE ON "${table}" ` +
          `FOR EACH ROW EXECUTE FUNCTION conversation_child_notify_executor()`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of CHILD_TABLES) {
      await queryRunner.query(
        `DROP TRIGGER "trg_${table}_notify_executor" ON "${table}"`,
      );
    }
    await queryRunner.query(
      `DROP TRIGGER "trg_conversation_key_grants_notify_executor" ON "conversation_key_grants"`,
    );
    await queryRunner.query(
      `DROP TRIGGER "trg_conversations_notify_executor" ON "conversations"`,
    );
    await queryRunner.query(
      `DROP FUNCTION conversation_key_grants_notify_executor()`,
    );
    await queryRunner.query(
      `DROP FUNCTION conversation_child_notify_executor()`,
    );
    await queryRunner.query(`DROP FUNCTION conversations_notify_executor()`);
  }
}
