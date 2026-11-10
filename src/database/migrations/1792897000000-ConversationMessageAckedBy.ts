import { MigrationInterface, QueryRunner } from 'typeorm';

// Quem confirmou (`ack`) a mensagem de uma pessoa (spec conversations §4.3; `AckMessageUseCase`): `acked_by_hub_id`.
// Quando o executor troca ou se perde (troca de executor, `HubExecutorLostHooks`, dono do Hub saindo do assunto), as
// mensagens que o Hub antigo confirmou e às quais ele não respondeu depois (nenhuma mensagem dele mais nova no assunto)
// voltam a `pending`: o Hub novo só trata `pending` como trabalho, e o antigo pode ter morrido com elas na fila
// (`ConversationMessageRepository.requeueAckedBy`). Mensagens confirmadas antes desta migration ficam sem o Hub (nulo)
// e nunca voltam. A mensagem do próprio Hub nasce confirmada sem `acked_by_hub_id` (o autor já é ele).
export class ConversationMessageAckedBy1792897000000 implements MigrationInterface {
  name = 'ConversationMessageAckedBy1792897000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD "acked_by_hub_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "ck_conversation_messages_acked_by" CHECK (("acked_by_hub_id" IS NULL) OR (NOT "pending"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_conversation_messages_acked_by_hubs_idx" ON "conversation_messages" ("acked_by_hub_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "fk_conversation_messages_acked_by_hubs" FOREIGN KEY ("acked_by_hub_id") REFERENCES "hubs"("id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "fk_conversation_messages_acked_by_hubs"`,
    );
    await queryRunner.query(
      `DROP INDEX "fk_conversation_messages_acked_by_hubs_idx"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "ck_conversation_messages_acked_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "acked_by_hub_id"`,
    );
  }
}
