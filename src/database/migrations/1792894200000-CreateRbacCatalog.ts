import { MigrationInterface, QueryRunner } from 'typeorm';
import { removeRbacCatalog, seedRbacCatalog } from '../rbac-catalog-seed.js';
import {
  addSyncVersionTrigger,
  dropSyncVersionTrigger,
} from '../../shared/infra/db/migration-helpers.js';

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

export class CreateRbacCatalog1792894200000 implements MigrationInterface {
  name = 'CreateRbacCatalog1792894200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "permissions" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "key" character varying(100) NOT NULL,
        "scope_type" character varying(20) NOT NULL,
        "name" character varying(255) NOT NULL,
        "description" character varying(500),
        CONSTRAINT "PK_permissions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_permissions_scope_type" CHECK ("scope_type" IN ('organization', 'space', 'hub'))
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_permissions_key" ON "permissions" ("key")`,
    );
    await addSyncVersionTrigger(queryRunner, 'permissions');

    await queryRunner.query(`
      CREATE TABLE "permission_dependency" (
        "permission_id" uuid NOT NULL,
        "requires_permission_id" uuid NOT NULL,${COMMON},
        CONSTRAINT "PK_permission_dependency" PRIMARY KEY ("permission_id", "requires_permission_id"),
        CONSTRAINT "fk_permission_dependency_permissions" FOREIGN KEY ("permission_id") REFERENCES "permissions" ("id"),
        CONSTRAINT "fk_permission_dependency_requires" FOREIGN KEY ("requires_permission_id") REFERENCES "permissions" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_permission_dependency_requires_idx" ON "permission_dependency" ("requires_permission_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'permission_dependency');

    // organization_id ganha a FK para organizations na migration que cria essa tabela.
    await queryRunner.query(`
      CREATE TABLE "roles" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid,
        "scope_type" character varying(20) NOT NULL,
        "key" character varying(50),
        "name" character varying(255) NOT NULL,
        "description" character varying(500),
        "copied_from_role_id" uuid,
        "permissions_reviewed_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_roles" PRIMARY KEY ("id"),
        CONSTRAINT "ck_roles_scope_type" CHECK ("scope_type" IN ('organization', 'space', 'hub')),
        CONSTRAINT "fk_roles_copied_from" FOREIGN KEY ("copied_from_role_id") REFERENCES "roles" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_roles_factory_key" ON "roles" ("key") WHERE "organization_id" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_roles_organization_key" ON "roles" ("organization_id", "key") WHERE "organization_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_roles_copied_from_idx" ON "roles" ("copied_from_role_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'roles');

    await queryRunner.query(`
      CREATE TABLE "role_permission" (
        "role_id" uuid NOT NULL,
        "permission_id" uuid NOT NULL,${COMMON},
        CONSTRAINT "PK_role_permission" PRIMARY KEY ("role_id", "permission_id"),
        CONSTRAINT "fk_role_permission_roles" FOREIGN KEY ("role_id") REFERENCES "roles" ("id"),
        CONSTRAINT "fk_role_permission_permissions" FOREIGN KEY ("permission_id") REFERENCES "permissions" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_role_permission_permissions_idx" ON "role_permission" ("permission_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'role_permission');

    await seedRbacCatalog(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await removeRbacCatalog(queryRunner);
    await dropSyncVersionTrigger(queryRunner, 'role_permission');
    await queryRunner.query(`DROP INDEX "fk_role_permission_permissions_idx"`);
    await queryRunner.query(`DROP TABLE "role_permission"`);
    await dropSyncVersionTrigger(queryRunner, 'roles');
    await queryRunner.query(`DROP INDEX "fk_roles_copied_from_idx"`);
    await queryRunner.query(`DROP INDEX "uq_roles_organization_key"`);
    await queryRunner.query(`DROP INDEX "uq_roles_factory_key"`);
    await queryRunner.query(`DROP TABLE "roles"`);
    await dropSyncVersionTrigger(queryRunner, 'permission_dependency');
    await queryRunner.query(
      `DROP INDEX "fk_permission_dependency_requires_idx"`,
    );
    await queryRunner.query(`DROP TABLE "permission_dependency"`);
    await dropSyncVersionTrigger(queryRunner, 'permissions');
    await queryRunner.query(`DROP INDEX "uq_permissions_key"`);
    await queryRunner.query(`DROP TABLE "permissions"`);
  }
}
