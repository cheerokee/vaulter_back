import { MigrationInterface, QueryRunner } from 'typeorm';

// Só atribuição de escopo espaço leva space_id (a outra metade do ck_role_assignments_space_scope): sem isso,
// uma linha de organização com space_id apareceria nas consultas por espaço sem ser um papel dele.
export class RoleAssignmentsSpaceIdScope1792894800000 implements MigrationInterface {
  name = 'RoleAssignmentsSpaceIdScope1792894800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "role_assignments" ADD CONSTRAINT "ck_role_assignments_space_id_scope" CHECK ("scope_type" = 'space' OR "space_id" IS NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "role_assignments" DROP CONSTRAINT "ck_role_assignments_space_id_scope"`,
    );
  }
}
