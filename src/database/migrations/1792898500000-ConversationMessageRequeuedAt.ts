import { MigrationInterface, QueryRunner } from 'typeorm';

// Quando uma mensagem voltou à fila (`requeueAckedBy`: o executor que a confirmou deixou de ser executor sem responder),
// no relógio do banco (Task 7, fix round 1). A nuvem de reserva conta os 30 s do Hub a partir do MAIOR entre `sent_at`
// e `requeued_at`: um Hub novo, ligado, tem os próprios 30 s para pegar o que voltou (spec active-cloud §2: a nuvem não
// rouba o papel do Hub). Coluna comum: policies, triggers de versão e de imutabilidade não mudam.
export class ConversationMessageRequeuedAt1792898500000 implements MigrationInterface {
  name = 'ConversationMessageRequeuedAt1792898500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD "requeued_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "requeued_at"`,
    );
  }
}
