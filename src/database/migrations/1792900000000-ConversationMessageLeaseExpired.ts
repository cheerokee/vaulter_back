import { MigrationInterface, QueryRunner } from 'typeorm';

// Decisão B8 do Jonas (27/11/2026): uma mensagem que volta à fila porque o prazo do ack do agente do PC venceu
// (`AgentLeaseSweepJob`) é respondida pela nuvem de reserva NA HORA, sem os 30 s do Hub: o agente já teve os 15 min
// dele, e a janela deixava um agente instável dar ack de novo e segurar o assunto indefinidamente. A marca é desta
// coluna: a varredura grava `true`, toda outra volta à fila (`requeueAckedBy`, inclusive a nuvem devolvendo) grava
// `false`. Coluna comum: policies, triggers de versão e de imutabilidade não mudam.
export class ConversationMessageLeaseExpired1792900000000 implements MigrationInterface {
  name = 'ConversationMessageLeaseExpired1792900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD "requeued_lease_expired" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "requeued_lease_expired"`,
    );
  }
}
