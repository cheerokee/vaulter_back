import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addSyncVersionTrigger,
  disableOrganizationRls,
  dropSyncVersionTrigger,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

// Espaços, versões da chave, cópias trancadas, pendências de trancar e intenções de convite.
// - Todas com `organization_id` (em space_keys e space_key_grants desnormalizado) e a mesma policy
//   `org_isolation` (ENABLE + FORCE, USING e WITH CHECK em `app.organization_id`). Sem SECURITY DEFINER.
// - spaces, space_keys e space_key_grants sincronizam (sync_version por trigger); as pendências e as intenções
//   são só do backend.
// - Lápide em vez de DELETE: os índices únicos são parciais (`deleted_at IS NULL`). O runtime fica com os
//   default privileges (SELECT, INSERT, UPDATE; sem DELETE).
// - space_key_grants.hub_id / app_installation_id nascem nulas e sem FK: as tabelas hubs e app_installations
//   chegam nos módulos delas (como em role_assignments).
// - role_assignments ganha a FK para spaces, o índice "uma atribuição de espaço ativa por pessoa" e a regra de
//   que uma linha de espaço tem space_id e organization_id (o RLS por organização continua valendo para ela;
//   a policy self_read já se limita a `user_id = app.user_id`).
export class CreateSpaces1792894500000 implements MigrationInterface {
  name = 'CreateSpaces1792894500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "spaces" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "cloud_mode" character varying(20) NOT NULL DEFAULT 'encrypted_backup',
        "allow_online_llm" boolean NOT NULL DEFAULT true,
        "current_key_version" integer NOT NULL DEFAULT 1,
        "key_rotation_required" boolean NOT NULL DEFAULT false,
        CONSTRAINT "PK_spaces" PRIMARY KEY ("id"),
        CONSTRAINT "ck_spaces_cloud_mode" CHECK ("cloud_mode" IN ('encrypted_backup', 'active_cloud')),
        CONSTRAINT "ck_spaces_current_key_version" CHECK ("current_key_version" >= 1),
        CONSTRAINT "fk_spaces_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_spaces_organizations_idx" ON "spaces" ("organization_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'spaces');

    await queryRunner.query(`
      CREATE TABLE "space_keys" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "version" integer NOT NULL,
        "recovery_wrapped_key" text NOT NULL,
        "recovery_key_fingerprint" character varying(64) NOT NULL,
        CONSTRAINT "PK_space_keys" PRIMARY KEY ("id"),
        CONSTRAINT "ck_space_keys_version" CHECK ("version" >= 1),
        CONSTRAINT "fk_space_keys_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_space_keys_spaces" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_space_keys_space_version" ON "space_keys" ("space_id", "version") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_space_keys_organizations_idx" ON "space_keys" ("organization_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'space_keys');

    await queryRunner.query(`
      CREATE TABLE "space_key_grants" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "space_key_id" uuid NOT NULL,
        "user_id" uuid,
        "hub_id" uuid,
        "app_installation_id" uuid,
        "wrapped_key" text NOT NULL,
        CONSTRAINT "PK_space_key_grants" PRIMARY KEY ("id"),
        CONSTRAINT "ck_space_key_grants_recipient" CHECK (num_nonnulls("user_id", "hub_id", "app_installation_id") = 1),
        CONSTRAINT "fk_space_key_grants_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_space_key_grants_space_keys" FOREIGN KEY ("space_key_id") REFERENCES "space_keys" ("id"),
        CONSTRAINT "fk_space_key_grants_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      )
    `);
    for (const [name, col] of [
      ['uq_space_key_grants_user', 'user_id'],
      ['uq_space_key_grants_hub', 'hub_id'],
      ['uq_space_key_grants_installation', 'app_installation_id'],
    ]) {
      await queryRunner.query(
        `CREATE UNIQUE INDEX "${name}" ON "space_key_grants" ("space_key_id", "${col}") WHERE "${col}" IS NOT NULL AND "deleted_at" IS NULL`,
      );
    }
    for (const [name, col] of [
      ['fk_space_key_grants_organizations_idx', 'organization_id'],
      ['fk_space_key_grants_users_idx', 'user_id'],
      ['fk_space_key_grants_hubs_idx', 'hub_id'],
      ['fk_space_key_grants_app_installations_idx', 'app_installation_id'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "space_key_grants" ("${col}")`,
      );
    }
    await addSyncVersionTrigger(queryRunner, 'space_key_grants');

    // Só do backend (sem sync_version).
    await queryRunner.query(`
      CREATE TABLE "space_pending_grants" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        "invitation_id" uuid,
        "requested_by_user_id" uuid,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        CONSTRAINT "PK_space_pending_grants" PRIMARY KEY ("id"),
        CONSTRAINT "ck_space_pending_grants_status" CHECK ("status" IN ('pending', 'granted', 'declined', 'cancelled')),
        CONSTRAINT "fk_space_pending_grants_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_space_pending_grants_spaces" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id"),
        CONSTRAINT "fk_space_pending_grants_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_space_pending_grants_roles" FOREIGN KEY ("role_id") REFERENCES "roles" ("id"),
        CONSTRAINT "fk_space_pending_grants_invitations" FOREIGN KEY ("invitation_id") REFERENCES "organization_invitations" ("id"),
        CONSTRAINT "fk_space_pending_grants_requested_by" FOREIGN KEY ("requested_by_user_id") REFERENCES "users" ("id")
      )
    `);
    // Uma pendência aberta por pessoa em cada espaço (as resolvidas ficam como histórico).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_space_pending_grants_open" ON "space_pending_grants" ("space_id", "user_id") WHERE "status" = 'pending' AND "deleted_at" IS NULL`,
    );
    for (const [name, col] of [
      ['fk_space_pending_grants_organizations_idx', 'organization_id'],
      ['fk_space_pending_grants_spaces_idx', 'space_id'],
      ['fk_space_pending_grants_users_idx', 'user_id'],
      ['fk_space_pending_grants_roles_idx', 'role_id'],
      ['fk_space_pending_grants_invitations_idx', 'invitation_id'],
      ['fk_space_pending_grants_requested_by_idx', 'requested_by_user_id'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "space_pending_grants" ("${col}")`,
      );
    }

    // Só do backend (sem sync_version).
    await queryRunner.query(`
      CREATE TABLE "invitation_space_intents" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "invitation_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "role_id" uuid NOT NULL,
        CONSTRAINT "PK_invitation_space_intents" PRIMARY KEY ("id"),
        CONSTRAINT "fk_invitation_space_intents_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_invitation_space_intents_invitations" FOREIGN KEY ("invitation_id") REFERENCES "organization_invitations" ("id"),
        CONSTRAINT "fk_invitation_space_intents_spaces" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id"),
        CONSTRAINT "fk_invitation_space_intents_roles" FOREIGN KEY ("role_id") REFERENCES "roles" ("id")
      )
    `);
    // Um espaço aparece uma vez por convite.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_invitation_space_intents_invitation_space" ON "invitation_space_intents" ("invitation_id", "space_id") WHERE "deleted_at" IS NULL`,
    );
    for (const [name, col] of [
      ['fk_invitation_space_intents_organizations_idx', 'organization_id'],
      ['fk_invitation_space_intents_invitations_idx', 'invitation_id'],
      ['fk_invitation_space_intents_spaces_idx', 'space_id'],
      ['fk_invitation_space_intents_roles_idx', 'role_id'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "invitation_space_intents" ("${col}")`,
      );
    }

    for (const table of [
      'spaces',
      'space_keys',
      'space_key_grants',
      'space_pending_grants',
      'invitation_space_intents',
    ]) {
      await enableOrganizationRls(queryRunner, table);
    }

    // role_assignments: membros de espaço.
    await queryRunner.query(
      `ALTER TABLE "role_assignments" ADD CONSTRAINT "fk_role_assignments_spaces" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" ADD CONSTRAINT "ck_role_assignments_space_scope" CHECK ("scope_type" <> 'space' OR ("space_id" IS NOT NULL AND "organization_id" IS NOT NULL))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_role_assignments_space_user" ON "role_assignments" ("space_id", "user_id") WHERE "scope_type" = 'space' AND "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "uq_role_assignments_space_user"`);
    await queryRunner.query(
      `ALTER TABLE "role_assignments" DROP CONSTRAINT "ck_role_assignments_space_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" DROP CONSTRAINT "fk_role_assignments_spaces"`,
    );

    // DROP TABLE leva índices, constraints, policies e triggers junto; o helper do RLS fica explícito por
    // simetria com o up.
    for (const table of [
      'invitation_space_intents',
      'space_pending_grants',
      'space_key_grants',
      'space_keys',
      'spaces',
    ]) {
      await disableOrganizationRls(queryRunner, table);
    }
    await queryRunner.query(`DROP TABLE "invitation_space_intents"`);
    await queryRunner.query(`DROP TABLE "space_pending_grants"`);
    await dropSyncVersionTrigger(queryRunner, 'space_key_grants');
    await queryRunner.query(`DROP TABLE "space_key_grants"`);
    await dropSyncVersionTrigger(queryRunner, 'space_keys');
    await queryRunner.query(`DROP TABLE "space_keys"`);
    await dropSyncVersionTrigger(queryRunner, 'spaces');
    await queryRunner.query(`DROP TABLE "spaces"`);
  }
}
