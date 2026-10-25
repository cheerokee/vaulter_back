import { MigrationInterface, QueryRunner } from 'typeorm';

// Quem indicou o espaço no convite (o Gestor que criou a intenção): no aceite, vira o requested_by da
// pendência de trancar. Nulo para as linhas que já existiam (o dado não foi guardado antes).
export class InvitationSpaceIntentsRequestedBy1792894700000 implements MigrationInterface {
  name = 'InvitationSpaceIntentsRequestedBy1792894700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invitation_space_intents" ADD "requested_by_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitation_space_intents" ADD CONSTRAINT "fk_invitation_space_intents_requested_by" FOREIGN KEY ("requested_by_user_id") REFERENCES "users" ("id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_invitation_space_intents_requested_by_idx" ON "invitation_space_intents" ("requested_by_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "fk_invitation_space_intents_requested_by_idx"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitation_space_intents" DROP CONSTRAINT "fk_invitation_space_intents_requested_by"`,
    );
    await queryRunner.query(
      `ALTER TABLE "invitation_space_intents" DROP COLUMN "requested_by_user_id"`,
    );
  }
}
