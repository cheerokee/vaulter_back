import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addSyncVersionTrigger,
  disableOrganizationRls,
  dropSyncVersionTrigger,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

// Contexto do RLS, gravado por transação (UnitOfWork.setContext / withContext). `app.organization_id` entra pela
// org_isolation do helper enableOrganizationRls.
const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;
const SIGNING_KEY = `NULLIF(current_setting('app.hub_signing_public_key', true), '')`;

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

// Membro ativo da organização da linha (pela policy self_read de user_organization; sem referência a hubs).
const MEMBER_OF = (orgColumn: string) => `EXISTS (
  SELECT 1 FROM user_organization uo
   WHERE uo.organization_id = ${orgColumn}
     AND uo.user_id = ${USER}
     AND uo.deleted_at IS NULL)`;

// Módulo de Hubs (spec hubs §5 e §8; decisões 5 e 6 do plano). Sem SECURITY DEFINER: as policies só leem
// current_setting e outras tabelas pelo papel de quem consulta. O runtime fica com os default privileges
// (SELECT, INSERT, UPDATE; sem DELETE) em todas as tabelas novas: sair/desregistrar é lápide ou status.
//
// Matriz de policies (permissivas: basta uma; `app.*` = current_setting):
//
// | Tabela | SELECT | INSERT | UPDATE |
// |---|---|---|---|
// | hubs | dono (`owner_user_id = app.user_id`); o próprio Hub (`id = app.hub_id`); membro ativo de organização com vínculo `approved` e sem lápide; a chave da busca (`signing_public_key = app.hub_signing_public_key`) | dono | dono ou o próprio Hub (`last_seen_at`) |
// | hub_organization | org_isolation; membro ativo da organização da linha; dono do Hub (`hub_owner_user_id = app.user_id`); o próprio Hub | org_isolation | org_isolation |
// | hub_space | org_isolation; membro ativo da organização da linha; dono do Hub (EXISTS hubs); o próprio Hub | org_isolation | org_isolation |
// | role_assignments, escopo hub (organization_id nulo) | self_read (já existe); dono do Hub (EXISTS hubs); o próprio Hub | dono do Hub | dono do Hub ou o próprio Hub |
// | hub_enrollments, hub_link_codes, hub_auth_challenges | sem RLS (só backend, sempre pela chave ou pelo hash) | idem | idem |
//
// - Sem recursão: a policy de hubs consulta hub_organization e user_organization; nenhuma policy dessas duas
//   consulta hubs. Por isso o dono lê hub_organization por uma coluna desnormalizada, `hub_owner_user_id`, com
//   FK composta (hub_id, hub_owner_user_id) -> hubs (id, owner_user_id): ninguém grava um dono falso (a FK ignora
//   o RLS) e trocar o dono de um Hub com vínculos falha na FK (transferência de posse, se vier, precisa mudar
//   isso). hub_space e role_assignments consultam hubs; nada que hubs consulta volta para eles.
// - Escrita em hub_organization e hub_space é sempre no escopo da organização da linha (os repositórios põem o
//   escopo, como no `spaces`); o dono e o Hub só leem.
// - `app.hub_id` é contexto de confiança do backend: o guard do token de Hub, a autenticação do Hub (antes do
//   token, para achar o Hub pelo id) e as cascatas que agem sobre um Hub (desvincular por admin, saída da
//   organização) o põem. Ele abre UPDATE nas atribuições de escopo hub para essas cascatas tirarem papéis de
//   Hub sem o dono estar presente.
// - `app.hub_signing_public_key` abre só o Hub daquela chave (busca da apresentação: chave já usada, inclusive
//   por Hub desregistrado), no padrão de `app.invitation_token_hash`.
// - Tabelas só do backend: fora do RLS (não são dado de cliente) e sem sync_version. Têm created_at/updated_at/
//   deleted_at como manda o DER. Apresentações vencidas viram `expired` por UPDATE (expireStale); códigos e
//   desafios usados/vencidos ficam como histórico. A remoção física das linhas antigas é pendência (uma rotina
//   com o papel dono ou uma exceção de DELETE documentada, como em rate_limit_hits).
// - FKs que faltavam: space_key_grants.hub_id, role_assignments.room_hub_id e role_assignments.hub_id -> hubs.
//   Simples (hubs não tem organization_id). role_assignments ganha os CHECKs do escopo hub e os únicos parciais
//   "um papel de Hub ativo por pessoa" e "uma Sala de escopo hub por Hub".
export class CreateHubs1792895000000 implements MigrationInterface {
  name = 'CreateHubs1792895000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "hubs" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "owner_user_id" uuid NOT NULL,
        "name" character varying(255) NOT NULL,
        "encryption_public_key" text NOT NULL,
        "signing_public_key" character varying(64) NOT NULL,
        "last_seen_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_hubs" PRIMARY KEY ("id"),
        CONSTRAINT "uq_hubs_id_owner" UNIQUE ("id", "owner_user_id"),
        CONSTRAINT "fk_hubs_users" FOREIGN KEY ("owner_user_id") REFERENCES "users" ("id")
      )
    `);
    // Única para sempre: sem WHERE deleted_at (um Hub desregistrado não volta com a mesma chave).
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hubs_signing_public_key" ON "hubs" ("signing_public_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_hubs_users_idx" ON "hubs" ("owner_user_id")`,
    );
    await addSyncVersionTrigger(queryRunner, 'hubs');

    await queryRunner.query(`
      CREATE TABLE "hub_enrollments" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "signing_public_key" character varying(64) NOT NULL,
        "encryption_public_key" text NOT NULL,
        "nonce" character varying(32) NOT NULL,
        "claim_code_hash" character varying(64) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "claimed_hub_id" uuid,
        CONSTRAINT "PK_hub_enrollments" PRIMARY KEY ("id"),
        CONSTRAINT "ck_hub_enrollments_status" CHECK ("status" IN ('pending', 'claimed', 'expired')),
        CONSTRAINT "ck_hub_enrollments_claimed_hub" CHECK (("status" = 'claimed') = ("claimed_hub_id" IS NOT NULL)),
        CONSTRAINT "fk_hub_enrollments_hubs" FOREIGN KEY ("claimed_hub_id") REFERENCES "hubs" ("id")
      )
    `);
    // nonce de uso único por chave (para sempre); código único entre as pendentes.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hub_enrollments_key_nonce" ON "hub_enrollments" ("signing_public_key", "nonce")`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hub_enrollments_claim_code_hash" ON "hub_enrollments" ("claim_code_hash") WHERE "status" = 'pending'`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_hub_enrollments_hubs_idx" ON "hub_enrollments" ("claimed_hub_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "hub_link_codes" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "hub_id" uuid NOT NULL,
        "code_hash" character varying(64) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_hub_link_codes" PRIMARY KEY ("id"),
        CONSTRAINT "fk_hub_link_codes_hubs" FOREIGN KEY ("hub_id") REFERENCES "hubs" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hub_link_codes_code_hash" ON "hub_link_codes" ("code_hash") WHERE "used_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_hub_link_codes_hubs_idx" ON "hub_link_codes" ("hub_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "hub_auth_challenges" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "hub_id" uuid,
        "challenge_hash" character varying(64) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_hub_auth_challenges" PRIMARY KEY ("id"),
        CONSTRAINT "fk_hub_auth_challenges_hubs" FOREIGN KEY ("hub_id") REFERENCES "hubs" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hub_auth_challenges_hash" ON "hub_auth_challenges" ("challenge_hash")`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_hub_auth_challenges_hubs_idx" ON "hub_auth_challenges" ("hub_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE "hub_organization" (
        "hub_id" uuid NOT NULL,
        "organization_id" uuid NOT NULL,${COMMON},
        "hub_owner_user_id" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "requested_by_user_id" uuid NOT NULL,
        "owner_approved_by_user_id" uuid,
        "owner_approved_at" TIMESTAMP WITH TIME ZONE,
        "org_approved_by_user_id" uuid,
        "org_approved_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_hub_organization" PRIMARY KEY ("hub_id", "organization_id"),
        CONSTRAINT "ck_hub_organization_status" CHECK ("status" IN ('pending', 'approved', 'rejected', 'revoked')),
        CONSTRAINT "ck_hub_organization_owner_consent" CHECK (("owner_approved_at" IS NULL) = ("owner_approved_by_user_id" IS NULL)),
        CONSTRAINT "ck_hub_organization_org_consent" CHECK (("org_approved_at" IS NULL) = ("org_approved_by_user_id" IS NULL)),
        CONSTRAINT "ck_hub_organization_approved" CHECK ("status" <> 'approved' OR "owner_approved_at" IS NOT NULL),
        CONSTRAINT "fk_hub_organization_hubs" FOREIGN KEY ("hub_id", "hub_owner_user_id") REFERENCES "hubs" ("id", "owner_user_id"),
        CONSTRAINT "fk_hub_organization_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_hub_organization_requested_by" FOREIGN KEY ("requested_by_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_hub_organization_owner_approved_by" FOREIGN KEY ("owner_approved_by_user_id") REFERENCES "users" ("id"),
        CONSTRAINT "fk_hub_organization_org_approved_by" FOREIGN KEY ("org_approved_by_user_id") REFERENCES "users" ("id")
      )
    `);
    for (const [name, cols] of [
      ['fk_hub_organization_organizations_idx', '"organization_id"'],
      ['fk_hub_organization_hubs_idx', '"hub_id", "hub_owner_user_id"'],
      ['fk_hub_organization_hub_owner_idx', '"hub_owner_user_id"'],
      ['fk_hub_organization_requested_by_idx', '"requested_by_user_id"'],
      [
        'fk_hub_organization_owner_approved_by_idx',
        '"owner_approved_by_user_id"',
      ],
      ['fk_hub_organization_org_approved_by_idx', '"org_approved_by_user_id"'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "hub_organization" (${cols})`,
      );
    }
    await addSyncVersionTrigger(queryRunner, 'hub_organization');

    await queryRunner.query(`
      CREATE TABLE "hub_space" (
        "hub_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,${COMMON},
        "organization_id" uuid NOT NULL,
        "added_by_user_id" uuid NOT NULL,
        CONSTRAINT "PK_hub_space" PRIMARY KEY ("hub_id", "space_id"),
        CONSTRAINT "fk_hub_space_hubs" FOREIGN KEY ("hub_id") REFERENCES "hubs" ("id"),
        CONSTRAINT "fk_hub_space_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces" ("id", "organization_id"),
        CONSTRAINT "fk_hub_space_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id"),
        CONSTRAINT "fk_hub_space_added_by" FOREIGN KEY ("added_by_user_id") REFERENCES "users" ("id")
      )
    `);
    for (const [name, cols] of [
      ['fk_hub_space_spaces_idx', '"space_id", "organization_id"'],
      ['fk_hub_space_organizations_idx', '"organization_id"'],
      ['fk_hub_space_added_by_idx', '"added_by_user_id"'],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "hub_space" (${cols})`,
      );
    }
    await addSyncVersionTrigger(queryRunner, 'hub_space');

    // FKs das colunas que nasceram antes da tabela hubs.
    await queryRunner.query(
      `ALTER TABLE "space_key_grants" ADD CONSTRAINT "fk_space_key_grants_hubs" FOREIGN KEY ("hub_id") REFERENCES "hubs" ("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" ADD CONSTRAINT "fk_role_assignments_room_hub" FOREIGN KEY ("room_hub_id") REFERENCES "hubs" ("id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" ADD CONSTRAINT "fk_role_assignments_hubs" FOREIGN KEY ("hub_id") REFERENCES "hubs" ("id")`,
    );
    // Escopo hub: hub_id preenchido e organization_id nulo (o Hub não é de organização); só ele leva hub_id.
    await queryRunner.query(
      `ALTER TABLE "role_assignments" ADD CONSTRAINT "ck_role_assignments_hub_scope" CHECK ("scope_type" <> 'hub' OR ("hub_id" IS NOT NULL AND "organization_id" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" ADD CONSTRAINT "ck_role_assignments_hub_id_scope" CHECK ("scope_type" = 'hub' OR "hub_id" IS NULL)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_role_assignments_hub_user" ON "role_assignments" ("hub_id", "user_id") WHERE "scope_type" = 'hub' AND "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_role_assignments_hub_room" ON "role_assignments" ("hub_id", "room_hub_id") WHERE "scope_type" = 'hub' AND "room_hub_id" IS NOT NULL AND "deleted_at" IS NULL`,
    );

    // RLS de hubs.
    await queryRunner.query(`ALTER TABLE "hubs" ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "hubs" FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(
      `CREATE POLICY "hubs_select" ON "hubs" FOR SELECT USING (
         owner_user_id = ${USER}
         OR id = ${HUB}
         OR EXISTS (
           SELECT 1 FROM hub_organization ho
             JOIN user_organization uo
               ON uo.organization_id = ho.organization_id
              AND uo.user_id = ${USER}
              AND uo.deleted_at IS NULL
            WHERE ho.hub_id = hubs.id
              AND ho.status = 'approved'
              AND ho.deleted_at IS NULL))`,
    );
    await queryRunner.query(
      `CREATE POLICY "hubs_by_signing_key" ON "hubs" FOR SELECT USING (signing_public_key = ${SIGNING_KEY})`,
    );
    await queryRunner.query(
      `CREATE POLICY "hubs_insert" ON "hubs" FOR INSERT WITH CHECK (owner_user_id = ${USER})`,
    );
    await queryRunner.query(
      `CREATE POLICY "hubs_update" ON "hubs" FOR UPDATE
         USING (owner_user_id = ${USER} OR id = ${HUB})
         WITH CHECK (owner_user_id = ${USER} OR id = ${HUB})`,
    );

    // RLS de hub_organization (nenhuma policy consulta hubs: sem recursão).
    await enableOrganizationRls(queryRunner, 'hub_organization');
    await queryRunner.query(
      `CREATE POLICY "member_read" ON "hub_organization" FOR SELECT USING (${MEMBER_OF('hub_organization.organization_id')})`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_owner_read" ON "hub_organization" FOR SELECT USING (hub_owner_user_id = ${USER})`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_organization" FOR SELECT USING (hub_id = ${HUB})`,
    );

    // RLS de hub_space.
    await enableOrganizationRls(queryRunner, 'hub_space');
    await queryRunner.query(
      `CREATE POLICY "member_read" ON "hub_space" FOR SELECT USING (${MEMBER_OF('hub_space.organization_id')})`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_owner_read" ON "hub_space" FOR SELECT USING (EXISTS (
         SELECT 1 FROM hubs h WHERE h.id = hub_space.hub_id AND h.owner_user_id = ${USER}))`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_space" FOR SELECT USING (hub_id = ${HUB})`,
    );

    // role_assignments, escopo hub (organization_id nulo: a org_isolation não alcança). self_read já existe.
    const HUB_OWNER = `scope_type = 'hub' AND EXISTS (
         SELECT 1 FROM hubs h WHERE h.id = role_assignments.hub_id AND h.owner_user_id = ${USER})`;
    const THE_HUB = `scope_type = 'hub' AND hub_id = ${HUB}`;
    await queryRunner.query(
      `CREATE POLICY "hub_scope_read" ON "role_assignments" FOR SELECT USING ((${HUB_OWNER}) OR (${THE_HUB}))`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_scope_insert" ON "role_assignments" FOR INSERT WITH CHECK (${HUB_OWNER})`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_scope_update" ON "role_assignments" FOR UPDATE
         USING ((${HUB_OWNER}) OR (${THE_HUB}))
         WITH CHECK ((${HUB_OWNER}) OR (${THE_HUB}))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const policy of [
      'hub_scope_update',
      'hub_scope_insert',
      'hub_scope_read',
    ]) {
      await queryRunner.query(`DROP POLICY "${policy}" ON "role_assignments"`);
    }
    await queryRunner.query(`DROP INDEX "uq_role_assignments_hub_room"`);
    await queryRunner.query(`DROP INDEX "uq_role_assignments_hub_user"`);
    await queryRunner.query(
      `ALTER TABLE "role_assignments" DROP CONSTRAINT "ck_role_assignments_hub_id_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" DROP CONSTRAINT "ck_role_assignments_hub_scope"`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" DROP CONSTRAINT "fk_role_assignments_hubs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "role_assignments" DROP CONSTRAINT "fk_role_assignments_room_hub"`,
    );
    await queryRunner.query(
      `ALTER TABLE "space_key_grants" DROP CONSTRAINT "fk_space_key_grants_hubs"`,
    );

    // As policies saem antes das tabelas: hubs_select depende de hub_organization, e hub_owner_read de hub_space
    // depende de hubs. DROP TABLE levaria índices, constraints e triggers junto; os helpers ficam explícitos por
    // simetria com o up.
    for (const policy of [
      'hubs_update',
      'hubs_insert',
      'hubs_by_signing_key',
      'hubs_select',
    ]) {
      await queryRunner.query(`DROP POLICY "${policy}" ON "hubs"`);
    }
    for (const table of ['hub_space', 'hub_organization']) {
      for (const policy of ['hub_read', 'hub_owner_read', 'member_read']) {
        await queryRunner.query(`DROP POLICY "${policy}" ON "${table}"`);
      }
      await disableOrganizationRls(queryRunner, table);
      await dropSyncVersionTrigger(queryRunner, table);
      await queryRunner.query(`DROP TABLE "${table}"`);
    }
    await queryRunner.query(`DROP TABLE "hub_auth_challenges"`);
    await queryRunner.query(`DROP TABLE "hub_link_codes"`);
    await queryRunner.query(`DROP TABLE "hub_enrollments"`);
    await queryRunner.query(`ALTER TABLE "hubs" NO FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE "hubs" DISABLE ROW LEVEL SECURITY`);
    await dropSyncVersionTrigger(queryRunner, 'hubs');
    await queryRunner.query(`DROP TABLE "hubs"`);
  }
}
