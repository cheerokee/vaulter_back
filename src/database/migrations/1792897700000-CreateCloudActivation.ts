import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableOrganizationRls } from '../../shared/infra/db/migration-helpers.js';

// Nuvem ativa, passo de ligar/desligar (spec active-cloud §4.1; módulo cloud):
// - `cloud_terms`: versões do termo, dado do servidor publicado SÓ por migration (como os catálogos): sem RLS, o
//   runtime só lê (REVOKE INSERT/UPDATE). Versão nova = migration nova com `INSERT` (texto + hash SHA-256 hex do texto
//   em UTF-8); o termo atual é a maior versão. A v1 abaixo é um RASCUNHO provisório: o texto final é do Jonas
//   (jurídico) e entra como v2 por migration.
// - `cloud_term_acceptances`: aceite por organização e versão (quem, quando, IP, hash do texto); append-only (o
//   runtime só tem SELECT/INSERT). RLS por organização.
// - `cloud_space_activations`: ciclos autorizado -> ativo por espaço, lápide ao desligar. RLS por organização.
// - `cloud_space_key_grants`: cópia de cada versão da chave do espaço para a chave do servidor. Legível depois de
//   aberta: desligar a nuvem APAGA as linhas de verdade, então o runtime tem DELETE aqui (exceção documentada à regra
//   do soft delete, como `rate_limit_hits`). RLS por organização.
// - `spaces.cloud_activated_at`: desde quando o espaço está em nuvem ativa (CHECK com `cloud_mode`).

const TERM_V1 = `RASCUNHO PROVISÓRIO — NÃO É O TEXTO FINAL. Substituir pela versão aprovada pelo jurídico antes de produção.

Termo de aceite da nuvem ativa (versão 1, provisória)

Ao ligar a nuvem ativa num espaço, a organização autoriza o serviço a ler o conteúdo desse espaço: o servidor recebe
uma cópia da chave do espaço, decifra o backup, extrai o texto dos arquivos, calcula embeddings e usa um modelo de
linguagem (Claude, pela Amazon Bedrock, na região us-east-1) para responder perguntas dos membros. Os dados não são
usados para treinar modelos.

Desligar a nuvem ativa apaga do servidor a cópia da chave e todo o conteúdo legível derivado do espaço; o backup
cifrado continua como estava.

O uso é medido e limitado pelo orçamento mensal de IA da organização.`;

export class CreateCloudActivation1792897700000 implements MigrationInterface {
  name = 'CreateCloudActivation1792897700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "cloud_terms" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "version" integer NOT NULL,
                "hash" character varying(64) NOT NULL,
                "text" text NOT NULL,
                "published_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                CONSTRAINT "uq_cloud_terms_version" UNIQUE ("version"),
                CONSTRAINT "ck_cloud_terms_hash" CHECK ("hash" ~ '^[0-9a-f]{64}$'),
                CONSTRAINT "ck_cloud_terms_version" CHECK ("version" >= 1),
                CONSTRAINT "PK_8d78f3972b1cdf3ec0301574b38" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE TABLE "cloud_term_acceptances" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "organization_id" uuid NOT NULL,
                "term_version" integer NOT NULL,
                "term_hash" character varying(64) NOT NULL,
                "accepted_by_user_id" uuid NOT NULL,
                "accepted_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "ip" character varying(45),
                CONSTRAINT "ck_cloud_term_acceptances_hash" CHECK ("term_hash" ~ '^[0-9a-f]{64}$'),
                CONSTRAINT "PK_a7d0efa8ad8c481ed3220490dbd" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_term_acceptances_cloud_terms_idx" ON "cloud_term_acceptances" ("term_version")
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_term_acceptances_users_idx" ON "cloud_term_acceptances" ("accepted_by_user_id")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_cloud_term_acceptances_org_version" ON "cloud_term_acceptances" ("organization_id", "term_version")
        `);
    await queryRunner.query(`
            CREATE TABLE "cloud_space_key_grants" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "organization_id" uuid NOT NULL,
                "space_id" uuid NOT NULL,
                "space_key_id" uuid NOT NULL,
                "key_version" integer NOT NULL,
                "wrapped_key" character varying(108) NOT NULL,
                CONSTRAINT "ck_cloud_space_key_grants_wrapped_key" CHECK ("wrapped_key" ~ '^[A-Za-z0-9_-]{108}$'),
                CONSTRAINT "ck_cloud_space_key_grants_version" CHECK ("key_version" >= 1),
                CONSTRAINT "PK_ef0160342c3855273b62f113d8e" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_space_key_grants_organizations_idx" ON "cloud_space_key_grants" ("organization_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_space_key_grants_spaces_idx" ON "cloud_space_key_grants" ("space_id", "organization_id")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_cloud_space_key_grants_space_key" ON "cloud_space_key_grants" ("space_key_id")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_cloud_space_key_grants_space_version" ON "cloud_space_key_grants" ("space_id", "key_version")
        `);
    await queryRunner.query(`
            CREATE TABLE "cloud_space_activations" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "organization_id" uuid NOT NULL,
                "space_id" uuid NOT NULL,
                "state" character varying(20) NOT NULL,
                "term_version" integer NOT NULL,
                "authorized_by_user_id" uuid NOT NULL,
                "authorized_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "activated_by_user_id" uuid,
                "activated_at" TIMESTAMP WITH TIME ZONE,
                "deactivated_by_user_id" uuid,
                CONSTRAINT "ck_cloud_space_activations_deactivated" CHECK (
                    ("deactivated_by_user_id" IS NULL)
                    OR ("deleted_at" IS NOT NULL)
                ),
                CONSTRAINT "ck_cloud_space_activations_activated" CHECK (
                    ("state" = 'active') = ("activated_at" IS NOT NULL)
                    AND ("activated_at" IS NULL) = ("activated_by_user_id" IS NULL)
                ),
                CONSTRAINT "ck_cloud_space_activations_state" CHECK ("state" IN ('authorized', 'active')),
                CONSTRAINT "PK_61521d8e90f2e49bddaea5e9227" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_space_activations_organizations_idx" ON "cloud_space_activations" ("organization_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_space_activations_spaces_idx" ON "cloud_space_activations" ("space_id", "organization_id")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_cloud_space_activations_live_space" ON "cloud_space_activations" ("space_id")
            WHERE "deleted_at" IS NULL
        `);
    await queryRunner.query(`
            ALTER TABLE "spaces"
            ADD "cloud_activated_at" TIMESTAMP WITH TIME ZONE
        `);
    await queryRunner.query(`
            ALTER TABLE "spaces"
            ADD CONSTRAINT "ck_spaces_cloud_activated_at" CHECK (
                    ("cloud_mode" = 'active_cloud') = ("cloud_activated_at" IS NOT NULL)
                )
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_term_acceptances"
            ADD CONSTRAINT "fk_cloud_term_acceptances_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_term_acceptances"
            ADD CONSTRAINT "fk_cloud_term_acceptances_cloud_terms" FOREIGN KEY ("term_version") REFERENCES "cloud_terms"("version") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_term_acceptances"
            ADD CONSTRAINT "fk_cloud_term_acceptances_users" FOREIGN KEY ("accepted_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_key_grants"
            ADD CONSTRAINT "fk_cloud_space_key_grants_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_key_grants"
            ADD CONSTRAINT "fk_cloud_space_key_grants_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_key_grants"
            ADD CONSTRAINT "fk_cloud_space_key_grants_space_keys" FOREIGN KEY ("space_key_id", "organization_id") REFERENCES "space_keys"("id", "organization_id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations"
            ADD CONSTRAINT "fk_cloud_space_activations_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations"
            ADD CONSTRAINT "fk_cloud_space_activations_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations"
            ADD CONSTRAINT "fk_cloud_space_activations_cloud_terms" FOREIGN KEY ("term_version") REFERENCES "cloud_terms"("version") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations"
            ADD CONSTRAINT "fk_cloud_space_activations_authorized_by" FOREIGN KEY ("authorized_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations"
            ADD CONSTRAINT "fk_cloud_space_activations_activated_by" FOREIGN KEY ("activated_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations"
            ADD CONSTRAINT "fk_cloud_space_activations_deactivated_by" FOREIGN KEY ("deactivated_by_user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    for (const table of [
      'cloud_term_acceptances',
      'cloud_space_activations',
      'cloud_space_key_grants',
    ]) {
      await enableOrganizationRls(queryRunner, table);
    }
    await queryRunner.query(
      `REVOKE INSERT, UPDATE ON "cloud_terms" FROM app_runtime`,
    );
    await queryRunner.query(
      `REVOKE UPDATE ON "cloud_term_acceptances" FROM app_runtime`,
    );
    await queryRunner.query(
      `GRANT DELETE ON "cloud_space_key_grants" TO app_runtime`,
    );
    await queryRunner.query(
      `INSERT INTO "cloud_terms" ("version", "hash", "text", "published_at")
       VALUES (1, encode(sha256(convert_to($1::text, 'UTF8')), 'hex'), $1::text, now())`,
      [TERM_V1],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations" DROP CONSTRAINT "fk_cloud_space_activations_deactivated_by"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations" DROP CONSTRAINT "fk_cloud_space_activations_activated_by"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations" DROP CONSTRAINT "fk_cloud_space_activations_authorized_by"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations" DROP CONSTRAINT "fk_cloud_space_activations_cloud_terms"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations" DROP CONSTRAINT "fk_cloud_space_activations_spaces"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_activations" DROP CONSTRAINT "fk_cloud_space_activations_organizations"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_key_grants" DROP CONSTRAINT "fk_cloud_space_key_grants_space_keys"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_key_grants" DROP CONSTRAINT "fk_cloud_space_key_grants_spaces"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_space_key_grants" DROP CONSTRAINT "fk_cloud_space_key_grants_organizations"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_term_acceptances" DROP CONSTRAINT "fk_cloud_term_acceptances_users"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_term_acceptances" DROP CONSTRAINT "fk_cloud_term_acceptances_cloud_terms"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_term_acceptances" DROP CONSTRAINT "fk_cloud_term_acceptances_organizations"
        `);
    await queryRunner.query(`
            ALTER TABLE "spaces" DROP CONSTRAINT "ck_spaces_cloud_activated_at"
        `);
    await queryRunner.query(`
            ALTER TABLE "spaces" DROP COLUMN "cloud_activated_at"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."uq_cloud_space_activations_live_space"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_space_activations_spaces_idx"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_space_activations_organizations_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_space_activations"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."uq_cloud_space_key_grants_space_version"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."uq_cloud_space_key_grants_space_key"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_space_key_grants_spaces_idx"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_space_key_grants_organizations_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_space_key_grants"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."uq_cloud_term_acceptances_org_version"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_term_acceptances_users_idx"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_term_acceptances_cloud_terms_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_term_acceptances"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_terms"
        `);
  }
}
