import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addSyncVersionTrigger,
  disableOrganizationRls,
  dropSyncVersionTrigger,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

// Contexto do RLS, gravado por transação (UnitOfWork.setContext / runInOrganizationScope).
const ORG = `NULLIF(current_setting('app.organization_id', true), '')::uuid`;
const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

// Organizações, membros, atribuições de papel, convites e auditoria, com Row-Level Security.
// - organizations: visível/alterável com `app.organization_id = id` ou se `app.user_id` for membro ativo
//   (app_is_member); INSERT só com `app.organization_id` igual ao id novo (quem cria põe o contexto antes).
// - user_organization e role_assignments: policy da organização + leitura das próprias linhas (app.user_id),
//   para "minhas organizações" sem abrir dado de quem não é membro.
// - organization_invitations e audit_logs: policy da organização. Busca de convite por token antes de haver
//   contexto: app_find_invitation (SECURITY DEFINER, só id e organization_id).
// - roles (tabela da Task 3): lê os de fábrica (organization_id nulo) e os da organização do contexto; grava
//   só os da organização do contexto. Ganha também a FK para organizations.
// - Catálogo (permissions, permission_dependency, role_permission): sem RLS, leitura livre.
// As funções SECURITY DEFINER pertencem ao dono das migrations e ignoram o RLS (superusuário) ou passam pela
// leitura própria de user_organization; search_path fixo para não serem sequestradas.
export class CreateOrganizations1792894300000 implements MigrationInterface {
  name = 'CreateOrganizations1792894300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "organizations" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "name" character varying(255) NOT NULL,
        "is_personal" boolean NOT NULL DEFAULT false,
        "hub_link_policy" character varying(20) NOT NULL DEFAULT 'any_member_hub',
        "plan" character varying(50) NOT NULL DEFAULT 'free',
        "recovery_public_key" text,
        "personal_owner_user_id" uuid,
        CONSTRAINT "PK_organizations" PRIMARY KEY ("id"),
        CONSTRAINT "ck_organizations_hub_link_policy" CHECK ("hub_link_policy" IN ('any_member_hub', 'admin_approved')),
        CONSTRAINT "ck_organizations_personal_owner" CHECK ("is_personal" = ("personal_owner_user_id" IS NOT NULL)),
        CONSTRAINT "fk_organizations_personal_owner" FOREIGN KEY ("personal_owner_user_id") REFERENCES "users" ("id")
      )
    `);
    // Exatamente uma organização pessoal por conta.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_organizations_personal_owner" ON "organizations" ("personal_owner_user_id") WHERE "personal_owner_user_id" IS NOT NULL`,
    );
    await addSyncVersionTrigger(queryRunner, 'organizations');

    await queryRunner.query(`
      CREATE TABLE "user_organization" (
        "organization_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,${COMMON},
        CONSTRAINT "PK_user_organization" PRIMARY KEY ("organization_id", "user_id"),
        CONSTRAINT "fk_user_organization_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_user_organization_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_user_organization_users_idx" ON "user_organization" ("user_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'user_organization');

    // Completa como no DER. FKs para hubs (room_hub_id, hub_id), spaces (space_id) e app_installations
    // (app_installation_id) entram nas migrations desses módulos.
    await queryRunner.query(`
      CREATE TABLE "role_assignments" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "role_id" uuid NOT NULL,
        "user_id" uuid,
        "room_hub_id" uuid,
        "app_installation_id" uuid,
        "scope_type" character varying(20) NOT NULL,
        "organization_id" uuid,
        "space_id" uuid,
        "hub_id" uuid,
        "granted_by_user_id" uuid,
        "approval_status" character varying(20) NOT NULL DEFAULT 'not_required',
        "approved_by_user_id" uuid,
        "approved_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_role_assignments" PRIMARY KEY ("id"),
        CONSTRAINT "ck_role_assignments_scope_type" CHECK ("scope_type" IN ('organization', 'space', 'hub')),
        CONSTRAINT "ck_role_assignments_approval_status" CHECK ("approval_status" IN ('not_required', 'pending', 'approved', 'rejected')),
        CONSTRAINT "ck_role_assignments_subject" CHECK (num_nonnulls("user_id", "room_hub_id", "app_installation_id") = 1),
        CONSTRAINT "ck_role_assignments_organization_scope" CHECK ("scope_type" <> 'organization' OR "organization_id" IS NOT NULL),
        CONSTRAINT "fk_role_assignments_roles" FOREIGN KEY ("role_id") REFERENCES "roles" ("id"),
        CONSTRAINT "fk_role_assignments_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_role_assignments_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_role_assignments_granted_by" FOREIGN KEY ("granted_by_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_role_assignments_approved_by" FOREIGN KEY ("approved_by_user_id") REFERENCES "users" ("id")
      )
    `);
    for (const [name, cols] of [
      ['fk_role_assignments_roles_idx', '"role_id"'],
      ['ix_role_assignments_user_scope', '"user_id", "scope_type"'],
      ['fk_role_assignments_room_hub_idx', '"room_hub_id"'],
      ['fk_role_assignments_organizations_idx', '"organization_id"'],
      ['fk_role_assignments_spaces_idx', '"space_id"'],
      ['fk_role_assignments_hubs_idx', '"hub_id"'],
      ['fk_role_assignments_granted_by_idx', '"granted_by_user_id"'],
      ['fk_role_assignments_app_installations_idx', '"app_installation_id"'],
      ['fk_role_assignments_approved_by_idx', '"approved_by_user_id"'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "role_assignments" (${cols})`,
      );
    }
    // Um papel de organização ativo por membro.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_role_assignments_org_user" ON "role_assignments" ("organization_id", "user_id") WHERE "scope_type" = 'organization' AND "deleted_at" IS NULL`,
    );
    await addSyncVersionTrigger(queryRunner, 'role_assignments');

    // Não sincroniza (sem sync_version).
    await queryRunner.query(`
      CREATE TABLE "organization_invitations" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "token_hash" character varying(128) NOT NULL,
        "email" character varying(255),
        "role_id" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_by_user_id" uuid NOT NULL,
        "accepted_by_user_id" uuid,
        "accepted_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_organization_invitations" PRIMARY KEY ("id"),
        CONSTRAINT "ck_organization_invitations_status" CHECK ("status" IN ('pending', 'accepted', 'revoked', 'expired')),
        CONSTRAINT "fk_organization_invitations_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_organization_invitations_roles" FOREIGN KEY ("role_id") REFERENCES "roles" ("id"),
        CONSTRAINT "fk_organization_invitations_created_by" FOREIGN KEY ("created_by_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_organization_invitations_accepted_by" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_organization_invitations_token_hash" ON "organization_invitations" ("token_hash")`,
    );
    for (const [name, col] of [
      ['fk_organization_invitations_organizations_idx', 'organization_id'],
      ['fk_organization_invitations_roles_idx', 'role_id'],
      ['fk_organization_invitations_created_by_idx', 'created_by_user_id'],
      ['fk_organization_invitations_accepted_by_idx', 'accepted_by_user_id'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "organization_invitations" ("${col}")`,
      );
    }

    // Completa como no DER. FKs para app_installations, spaces e hubs entram nas migrations desses módulos.
    await queryRunner.query(`
      CREATE TABLE "audit_logs" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "app_installation_id" uuid,
        "user_id" uuid,
        "action" character varying(100) NOT NULL,
        "scope_type" character varying(20),
        "space_id" uuid,
        "hub_id" uuid,
        "result" character varying(20) NOT NULL,
        "ip" character varying(45),
        "metadata" jsonb,
        CONSTRAINT "PK_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "ck_audit_logs_scope_type" CHECK ("scope_type" IS NULL OR "scope_type" IN ('organization', 'space', 'hub')),
        CONSTRAINT "ck_audit_logs_result" CHECK ("result" IN ('success', 'denied', 'error', 'hub_offline')),
        CONSTRAINT "fk_audit_logs_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_audit_logs_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      )
    `);
    for (const [name, cols] of [
      ['ix_audit_logs_organization_created', '"organization_id", "created_at"'],
      ['fk_audit_logs_app_installations_idx', '"app_installation_id"'],
      ['fk_audit_logs_users_idx', '"user_id"'],
      ['fk_audit_logs_spaces_idx', '"space_id"'],
      ['fk_audit_logs_hubs_idx', '"hub_id"'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "audit_logs" (${cols})`,
      );
    }
    // Só de acréscimo: os default privileges dão UPDATE ao runtime; aqui ele fica só com INSERT e SELECT.
    await queryRunner.query(`REVOKE UPDATE ON "audit_logs" FROM app_runtime`);

    // FK adiada da Task 3 (roles nasceu antes de organizations).
    await queryRunner.query(
      `ALTER TABLE "roles" ADD CONSTRAINT "fk_roles_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
    );

    // Funções SECURITY DEFINER usadas pelo RLS e pelo convite.
    await queryRunner.query(`
      CREATE FUNCTION app_is_member(org uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM user_organization uo
           WHERE uo.organization_id = $1
             AND uo.user_id = ${USER}
             AND uo.deleted_at IS NULL
        )
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_is_member(uuid) FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_is_member(uuid) TO app_runtime`,
    );
    // Devolve o convite em qualquer status (o domínio decide se vale), mas só id e organization_id.
    await queryRunner.query(`
      CREATE FUNCTION app_find_invitation(token_hash text)
      RETURNS TABLE (id uuid, organization_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
        SELECT i.id, i.organization_id FROM organization_invitations i
         WHERE i.token_hash = $1 AND i.deleted_at IS NULL
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_find_invitation(text) FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_find_invitation(text) TO app_runtime`,
    );

    // RLS.
    await queryRunner.query(
      `ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY`,
    );
    await queryRunner.query(
      `CREATE POLICY "org_member_select" ON "organizations" FOR SELECT USING (id = ${ORG} OR app_is_member(id))`,
    );
    await queryRunner.query(
      `CREATE POLICY "org_member_update" ON "organizations" FOR UPDATE USING (id = ${ORG} OR app_is_member(id)) WITH CHECK (id = ${ORG} OR app_is_member(id))`,
    );
    await queryRunner.query(
      `CREATE POLICY "org_insert" ON "organizations" FOR INSERT WITH CHECK (id = ${ORG})`,
    );

    for (const table of ['user_organization', 'role_assignments']) {
      await enableOrganizationRls(queryRunner, table);
      await queryRunner.query(
        `CREATE POLICY "self_read" ON "${table}" FOR SELECT USING (user_id = ${USER})`,
      );
    }
    await enableOrganizationRls(queryRunner, 'organization_invitations');
    await enableOrganizationRls(queryRunner, 'audit_logs');

    await queryRunner.query(`ALTER TABLE "roles" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "roles" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `CREATE POLICY "roles_read" ON "roles" FOR SELECT USING (organization_id IS NULL OR organization_id = ${ORG})`,
    );
    await queryRunner.query(
      `CREATE POLICY "roles_insert" ON "roles" FOR INSERT WITH CHECK (organization_id = ${ORG})`,
    );
    await queryRunner.query(
      `CREATE POLICY "roles_update" ON "roles" FOR UPDATE USING (organization_id = ${ORG}) WITH CHECK (organization_id = ${ORG})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY "roles_update" ON "roles"`);
    await queryRunner.query(`DROP POLICY "roles_insert" ON "roles"`);
    await queryRunner.query(`DROP POLICY "roles_read" ON "roles"`);
    await queryRunner.query(`ALTER TABLE "roles" NO FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "roles" DISABLE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `ALTER TABLE "roles" DROP CONSTRAINT "fk_roles_organizations"`,
    );

    await queryRunner.query(`DROP FUNCTION app_find_invitation(text)`);

    await queryRunner.query(`DROP INDEX "fk_audit_logs_hubs_idx"`);
    await queryRunner.query(`DROP INDEX "fk_audit_logs_spaces_idx"`);
    await queryRunner.query(`DROP INDEX "fk_audit_logs_users_idx"`);
    await queryRunner.query(`DROP INDEX "fk_audit_logs_app_installations_idx"`);
    await queryRunner.query(`DROP INDEX "ix_audit_logs_organization_created"`);
    await disableOrganizationRls(queryRunner, 'audit_logs');
    await queryRunner.query(`DROP TABLE "audit_logs"`);

    await disableOrganizationRls(queryRunner, 'organization_invitations');
    await queryRunner.query(`DROP TABLE "organization_invitations"`);

    await queryRunner.query(`DROP POLICY "self_read" ON "role_assignments"`);
    await disableOrganizationRls(queryRunner, 'role_assignments');
    await dropSyncVersionTrigger(queryRunner, 'role_assignments');
    await queryRunner.query(`DROP TABLE "role_assignments"`);

    // app_is_member depende de user_organization: sai antes da tabela e depois da policy que a usa.
    await queryRunner.query(`DROP POLICY "org_insert" ON "organizations"`);
    await queryRunner.query(
      `DROP POLICY "org_member_update" ON "organizations"`,
    );
    await queryRunner.query(
      `DROP POLICY "org_member_select" ON "organizations"`,
    );
    await queryRunner.query(`DROP FUNCTION app_is_member(uuid)`);

    await queryRunner.query(`DROP POLICY "self_read" ON "user_organization"`);
    await disableOrganizationRls(queryRunner, 'user_organization');
    await dropSyncVersionTrigger(queryRunner, 'user_organization');
    await queryRunner.query(`DROP TABLE "user_organization"`);

    await dropSyncVersionTrigger(queryRunner, 'organizations');
    await queryRunner.query(`DROP TABLE "organizations"`);
  }
}
