import { MigrationInterface, QueryRunner } from 'typeorm';

// `conversation_messages.answers_message_id` passa a ser imutável no banco (antes só pelo código): a resposta do agente
// diz qual mensagem ela responde, e "respondida pelo agente" (turno, renovação, varredura do prazo, `requeueAckedBy`)
// depende disso. O trigger `trg_conversation_messages_immutable` (função `conversation_rows_immutable`, migration
// ConversationsHardening) é recriado com a coluna nova na lista; o nome não muda, então continua antes do
// `trg_conversation_messages_zz_sync_version`.
const IMMUTABLE_MESSAGES_BEFORE = [
  'organization_id',
  'conversation_id',
  'author_user_id',
  'author_hub_id',
  'key_version',
  'author_cloud',
];

export class ConversationAnswersImmutable1792899800000 implements MigrationInterface {
  name = 'ConversationAnswersImmutable1792899800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.immutable(queryRunner, [
      ...IMMUTABLE_MESSAGES_BEFORE,
      'answers_message_id',
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await this.immutable(queryRunner, IMMUTABLE_MESSAGES_BEFORE);
  }

  private async immutable(qr: QueryRunner, columns: string[]): Promise<void> {
    await qr.query(
      `DROP TRIGGER "trg_conversation_messages_immutable" ON "conversation_messages"`,
    );
    await qr.query(
      `CREATE TRIGGER "trg_conversation_messages_immutable" BEFORE UPDATE ON "conversation_messages" ` +
        `FOR EACH ROW EXECUTE FUNCTION conversation_rows_immutable(${columns.map((c) => `'${c}'`).join(', ')})`,
    );
  }
}
