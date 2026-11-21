import { MigrationInterface, QueryRunner } from 'typeorm';

const SWEEP = `current_setting('app.agent_lease_sweep', true) = 'on'`;
const LEASED = `"acked_lease_until" IS NOT NULL`;
const VISIBLE = `EXISTS (
  SELECT 1 FROM conversations c
   WHERE c.id = conversation_messages.conversation_id AND c.organization_id = conversation_messages.organization_id)`;

// Prazo do ack do agente do PC (spec pc-agent §5.3, "Prazo do ack do agente"; Task 9 do plano):
// - `conversation_messages.acked_lease_until`: até quando o ack de um Hub `pc` segura a mensagem (relógio do banco;
//   `acked_at` + `AGENT_ACK_LEASE_MS`, renovado por cada passo do cérebro e por `POST .../messages/:messageId/lease`).
//   Nulo em todo outro ack e enquanto `pending`; CHECK: só com `acked_by_hub_id` (some junto com o ack, em
//   `requeueAckedBy` e na varredura). Coluna comum: os triggers de versão e de imutabilidade não mudam (renovar grava a
//   linha e ela sai de novo nos feeds, como um ack).
// - Índice parcial `ix_conversation_messages_agent_lease` (candidatos da varredura).
// - A varredura (`AgentLeaseSweepJob`, tarefa do pg-boss a cada minuto) precisa ACHAR os prazos vencidos sem ser
//   participante nem executor, em todas as organizações. Chave de confiança só do backend, como `app.storage_reconcile`:
//   `app.agent_lease_sweep = 'on'` abre o SELECT só das linhas com prazo (policy permissiva
//   `conversation_message_agent_lease_read` e um OR na restritiva `conversation_child_read`, que mantém o escape do
//   commit `sync_commit_in_progress()`). Nada mais: nenhuma escrita, nenhuma outra tabela (o assunto é lido no contexto
//   do Hub que confirmou e a volta à fila é gravada no contexto do DONO do assunto, como o executor perdido). A
//   varredura só pede ids (organização, assunto, Hub).
export class ConversationAgentAckLease1792899400000 implements MigrationInterface {
  name = 'ConversationAgentAckLease1792899400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD "acked_lease_until" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" ADD CONSTRAINT "ck_conversation_messages_acked_lease" CHECK (("acked_lease_until" IS NULL) OR ("acked_by_hub_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_conversation_messages_agent_lease" ON "conversation_messages" ("acked_lease_until") WHERE "acked_lease_until" IS NOT NULL AND NOT "pending"`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_message_agent_lease_read" ON "conversation_messages" FOR SELECT ` +
        `USING (${SWEEP} AND ${LEASED})`,
    );
    await this.childRead(
      queryRunner,
      `(sync_commit_in_progress() OR ${VISIBLE} OR (${SWEEP} AND ${LEASED}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.childRead(
      queryRunner,
      `(sync_commit_in_progress() OR ${VISIBLE})`,
    );
    await queryRunner.query(
      `DROP POLICY "conversation_message_agent_lease_read" ON "conversation_messages"`,
    );
    await queryRunner.query(
      `DROP INDEX "ix_conversation_messages_agent_lease"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP CONSTRAINT "ck_conversation_messages_acked_lease"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversation_messages" DROP COLUMN "acked_lease_until"`,
    );
  }

  private async childRead(queryRunner: QueryRunner, using: string) {
    await queryRunner.query(
      `DROP POLICY "conversation_child_read" ON "conversation_messages"`,
    );
    await queryRunner.query(
      `CREATE POLICY "conversation_child_read" ON "conversation_messages" AS RESTRICTIVE FOR SELECT USING ${using}`,
    );
  }
}
