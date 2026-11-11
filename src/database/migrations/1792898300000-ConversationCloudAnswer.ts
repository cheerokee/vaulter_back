import { MigrationInterface, QueryRunner } from 'typeorm';

// "Responder pela nuvem" (spec active-cloud §4.3; Task 7 do plano da nuvem ativa): a pessoa pede que a nuvem responda
// na hora, sem esperar os 30 s do Hub, no assunto inteiro (`conversations.cloud_answer`, só com a reserva ligada) ou
// numa mensagem (`conversation_messages.cloud_answer_requested`, só mensagem de pessoa, gravado no envio). Os dois
// saem nos feeds (o Hub deixa essas mensagens para a nuvem; docs/hubs/hub-lifecycle.md). Colunas comuns: as policies, o
// trigger de versão no COMMIT e os de imutabilidade não mudam.
export class ConversationCloudAnswer1792898300000 implements MigrationInterface {
  name = 'ConversationCloudAnswer1792898300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "cloud_answer" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "ck_conversations_cloud_answer" CHECK ((NOT "cloud_answer") OR "cloud_reserve")`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD "cloud_answer_requested" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "ck_conversation_messages_cloud_answer" CHECK ((NOT "cloud_answer_requested") OR ("author_user_id" IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "ck_conversation_messages_cloud_answer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "cloud_answer_requested"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "ck_conversations_cloud_answer"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "cloud_answer"`,
    );
  }
}
