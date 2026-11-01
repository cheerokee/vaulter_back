import { MigrationInterface, QueryRunner } from 'typeorm';

// Integração do módulo de Hubs com organizations/spaces (spec hubs §5 e §6):
// - `organizations.allow_room_spaces`: política da organização que permite liberar espaços na Sala dos Hubs
//   (padrão true; desligar bloqueia só novas liberações);
// - no máximo uma atribuição de Sala ativa por (espaço, Hub): o `uq_role_assignments_space_user` não cobre as
//   linhas da Sala (user_id nulo nunca colide num índice único).
export class AllowRoomSpacesAndRoomIndex1792894900000 implements MigrationInterface {
  name = 'AllowRoomSpacesAndRoomIndex1792894900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "organizations" ADD "allow_room_spaces" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_role_assignments_space_room_hub" ON "role_assignments" ("space_id", "room_hub_id") WHERE "scope_type" = 'space' AND "room_hub_id" IS NOT NULL AND "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_role_assignments_space_room_hub"`);
    await queryRunner.query(
      `ALTER TABLE "organizations" DROP COLUMN "allow_room_spaces"`,
    );
  }
}
