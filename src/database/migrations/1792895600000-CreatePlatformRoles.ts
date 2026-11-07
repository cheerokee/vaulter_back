import { MigrationInterface, QueryRunner } from 'typeorm';

// Papéis da plataforma (spec docs/superpowers/specs/2026-11-07-platform-roles-design.md): catálogo (papéis,
// permissões e ligações, semeado aqui com ids UUID v7 fixos), atribuições, pedidos de suporte e a trilha da equipe.
// Só do backend: sem organization_id, sem RLS, sem sync_version e fora da sincronização do Hub.
// Permissões do runtime (os privilégios padrão dão SELECT/INSERT/UPDATE em toda tabela nova; aqui se restringe):
// - catálogo (platform_roles, platform_permissions, platform_role_permission): só SELECT;
// - user_platform_role, platform_support_requests: SELECT, INSERT, UPDATE (lápide, sem DELETE);
// - platform_audit_logs: SELECT, INSERT (só de acréscimo).
// Dados congelados: nada é exportado além da classe (o TypeORM trata todo export como migration); mudança no
// catálogo = nova migration, nunca edição aqui. O e2e confere banco == src/platform/domain/platform-catalog.ts.
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

const CATALOG_PERMISSIONS = {
  'platform.roles.manage': '01a1b724-278a-76c1-a789-1700aea4a836',
  'platform.support.request': '01a1b724-278a-76c1-a789-19fe86c5bef4',
  'platform.support.approve': '01a1b724-278a-76c1-a789-1c23d616dd14',
  'platform.support.execute_alone': '01a1b724-278a-76c1-a789-211649f3a7a0',
  'platform.audit.read': '01a1b724-278a-76c1-a789-255cfff5ecc9',
} as const;

const CATALOG_ROLES = {
  platform_admin: [
    '01a1b724-2788-73ce-9c13-186c5ead667c',
    'Administrador da plataforma',
  ],
  platform_support: ['01a1b724-278a-76c1-a789-2b19c8a80a36', 'Suporte'],
  platform_finance: ['01a1b724-278a-76c1-a789-2c8a3bfda49a', 'Financeiro'],
} as const;

const CATALOG_ROLE_PERMISSIONS: Record<
  keyof typeof CATALOG_ROLES,
  (keyof typeof CATALOG_PERMISSIONS)[]
> = {
  platform_admin: [
    'platform.roles.manage',
    'platform.support.request',
    'platform.support.approve',
    'platform.support.execute_alone',
    'platform.audit.read',
  ],
  platform_support: ['platform.support.request', 'platform.audit.read'],
  platform_finance: [],
};

async function seedPlatformCatalog(db: Queryable): Promise<void> {
  for (const [key, id] of Object.entries(CATALOG_PERMISSIONS)) {
    await db.query(
      `INSERT INTO "platform_permissions" ("id", "key") VALUES ($1, $2)`,
      [id, key],
    );
  }
  for (const [key, [id, name]] of Object.entries(CATALOG_ROLES)) {
    await db.query(
      `INSERT INTO "platform_roles" ("id", "key", "name") VALUES ($1, $2, $3)`,
      [id, key, name],
    );
  }
  for (const [role, perms] of Object.entries(CATALOG_ROLE_PERMISSIONS)) {
    for (const perm of perms) {
      await db.query(
        `INSERT INTO "platform_role_permission" ("platform_role_id", "platform_permission_id") VALUES ($1, $2)`,
        [
          CATALOG_ROLES[role as keyof typeof CATALOG_ROLES][0],
          CATALOG_PERMISSIONS[perm],
        ],
      );
    }
  }
}

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

export class CreatePlatformRoles1792895600000 implements MigrationInterface {
  name = 'CreatePlatformRoles1792895600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "platform_roles" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "key" character varying(50) NOT NULL,
        "name" character varying(255) NOT NULL,
        CONSTRAINT "PK_platform_roles" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_platform_roles_key" ON "platform_roles" ("key") WHERE "deleted_at" IS NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE "platform_permissions" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "key" character varying(100) NOT NULL,
        CONSTRAINT "PK_platform_permissions" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_platform_permissions_key" ON "platform_permissions" ("key")`,
    );

    await queryRunner.query(`
      CREATE TABLE "platform_role_permission" (
        "platform_role_id" uuid NOT NULL,
        "platform_permission_id" uuid NOT NULL,${COMMON},
        CONSTRAINT "PK_platform_role_permission" PRIMARY KEY ("platform_role_id", "platform_permission_id"),
        CONSTRAINT "fk_platform_role_permission_platform_roles" FOREIGN KEY ("platform_role_id") REFERENCES "platform_roles" ("id"),
        CONSTRAINT "fk_platform_role_permission_platform_permissions" FOREIGN KEY ("platform_permission_id") REFERENCES "platform_permissions" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_platform_role_permission_platform_permissions_idx" ON "platform_role_permission" ("platform_permission_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "user_platform_role" (
        "user_id" uuid NOT NULL,
        "platform_role_id" uuid NOT NULL,${COMMON},
        CONSTRAINT "PK_user_platform_role" PRIMARY KEY ("user_id", "platform_role_id"),
        CONSTRAINT "fk_user_platform_role_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_user_platform_role_platform_roles" FOREIGN KEY ("platform_role_id") REFERENCES "platform_roles" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "fk_user_platform_role_platform_roles_idx" ON "user_platform_role" ("platform_role_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "platform_support_requests" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "type" character varying(30) NOT NULL,
        "status" character varying(20) NOT NULL,
        "requested_by_user_id" uuid NOT NULL,
        "target_hub_id" uuid,
        "target_organization_id" uuid,
        "target_user_id" uuid,
        "reason" text NOT NULL,
        "evidence" text NOT NULL,
        "decided_by_user_id" uuid,
        "decided_at" TIMESTAMP WITH TIME ZONE,
        "decision_note" text,
        "executed_at" TIMESTAMP WITH TIME ZONE,
        "failure_type" character varying(100),
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        CONSTRAINT "PK_platform_support_requests" PRIMARY KEY ("id"),
        CONSTRAINT "ck_platform_support_requests_type" CHECK ("type" IN ('hub_force_deregister', 'org_appoint_admin')),
        CONSTRAINT "ck_platform_support_requests_status" CHECK ("status" IN ('pending', 'executed', 'rejected', 'expired', 'failed')),
        CONSTRAINT "ck_platform_support_requests_target" CHECK (("type" = 'hub_force_deregister' AND "target_hub_id" IS NOT NULL AND "target_organization_id" IS NULL AND "target_user_id" IS NULL) OR ("type" = 'org_appoint_admin' AND "target_hub_id" IS NULL AND "target_organization_id" IS NOT NULL AND "target_user_id" IS NOT NULL)),
        CONSTRAINT "fk_platform_support_requests_requested_by" FOREIGN KEY ("requested_by_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_platform_support_requests_target_hub" FOREIGN KEY ("target_hub_id") REFERENCES "hubs" ("id"),
        CONSTRAINT "fk_platform_support_requests_target_organization" FOREIGN KEY ("target_organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_platform_support_requests_target_user" FOREIGN KEY ("target_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_platform_support_requests_decided_by" FOREIGN KEY ("decided_by_user_id") REFERENCES "users" ("id")
      )
    `);
    for (const [name, cols] of [
      ['ix_platform_support_requests_status_created', '"status", "created_at"'],
      [
        'fk_platform_support_requests_requested_by_idx',
        '"requested_by_user_id"',
      ],
      ['fk_platform_support_requests_decided_by_idx', '"decided_by_user_id"'],
      ['fk_platform_support_requests_target_hub_idx', '"target_hub_id"'],
      [
        'fk_platform_support_requests_target_organization_idx',
        '"target_organization_id"',
      ],
      ['fk_platform_support_requests_target_user_idx', '"target_user_id"'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "platform_support_requests" (${cols})`,
      );
    }

    await queryRunner.query(`
      CREATE TABLE "platform_audit_logs" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "user_id" uuid,
        "action" character varying(100) NOT NULL,
        "support_request_id" uuid,
        "target_user_id" uuid,
        "target_hub_id" uuid,
        "target_organization_id" uuid,
        "result" character varying(20) NOT NULL,
        "metadata" jsonb,
        CONSTRAINT "PK_platform_audit_logs" PRIMARY KEY ("id"),
        CONSTRAINT "ck_platform_audit_logs_result" CHECK ("result" IN ('success', 'denied', 'error')),
        CONSTRAINT "fk_platform_audit_logs_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_platform_audit_logs_support_requests" FOREIGN KEY ("support_request_id") REFERENCES "platform_support_requests" ("id"),
        CONSTRAINT "fk_platform_audit_logs_target_user" FOREIGN KEY ("target_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_platform_audit_logs_target_hub" FOREIGN KEY ("target_hub_id") REFERENCES "hubs" ("id"),
        CONSTRAINT "fk_platform_audit_logs_target_organization" FOREIGN KEY ("target_organization_id") REFERENCES "organizations" ("id")
      )
    `);
    for (const [name, col] of [
      ['ix_platform_audit_logs_created', 'created_at'],
      ['fk_platform_audit_logs_users_idx', 'user_id'],
      ['fk_platform_audit_logs_support_requests_idx', 'support_request_id'],
      ['fk_platform_audit_logs_target_user_idx', 'target_user_id'],
      ['fk_platform_audit_logs_target_hub_idx', 'target_hub_id'],
      [
        'fk_platform_audit_logs_target_organization_idx',
        'target_organization_id',
      ],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "platform_audit_logs" ("${col}")`,
      );
    }

    await queryRunner.query(
      `REVOKE INSERT, UPDATE, DELETE ON "platform_roles", "platform_permissions", "platform_role_permission" FROM app_runtime`,
    );
    await queryRunner.query(
      `GRANT SELECT ON "platform_roles", "platform_permissions", "platform_role_permission" TO app_runtime`,
    );
    await queryRunner.query(
      `REVOKE DELETE ON "user_platform_role", "platform_support_requests" FROM app_runtime`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT, UPDATE ON "user_platform_role", "platform_support_requests" TO app_runtime`,
    );
    await queryRunner.query(
      `REVOKE UPDATE, DELETE ON "platform_audit_logs" FROM app_runtime`,
    );
    await queryRunner.query(
      `GRANT SELECT, INSERT ON "platform_audit_logs" TO app_runtime`,
    );

    await seedPlatformCatalog(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // DROP TABLE leva junto índices, constraints, privilégios e o catálogo semeado.
    await queryRunner.query(`DROP TABLE "platform_audit_logs"`);
    await queryRunner.query(`DROP TABLE "platform_support_requests"`);
    await queryRunner.query(`DROP TABLE "user_platform_role"`);
    await queryRunner.query(`DROP TABLE "platform_role_permission"`);
    await queryRunner.query(`DROP TABLE "platform_permissions"`);
    await queryRunner.query(`DROP TABLE "platform_roles"`);
  }
}
