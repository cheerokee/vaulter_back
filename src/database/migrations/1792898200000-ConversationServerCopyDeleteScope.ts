import { MigrationInterface, QueryRunner } from 'typeorm';

const NO_HUB = `NULLIF(current_setting('app.hub_id', true), '') IS NULL`;
const NO_CLOUD = `NULLIF(current_setting('app.cloud_executor', true), '') IS NULL`;

// Defesa em profundidade (revisão da Task 6): só um PARTICIPANTE apaga as cópias da chave do assunto para o servidor
// (o dono desliga, a lápide do assunto, o espaço sai da nuvem ativa: tudo no contexto de uma pessoa). Nem o contexto
// de um Hub executor nem o da nuvem (`app.cloud_executor`) apagam, embora vejam as linhas.
export class ConversationServerCopyDeleteScope1792898200000 implements MigrationInterface {
  name = 'ConversationServerCopyDeleteScope1792898200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER POLICY "conversation_server_copy_delete" ON "conversation_key_grants" ` +
        `USING ("server_recipient" AND ${NO_HUB} AND ${NO_CLOUD})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER POLICY "conversation_server_copy_delete" ON "conversation_key_grants" USING ("server_recipient")`,
    );
  }
}
