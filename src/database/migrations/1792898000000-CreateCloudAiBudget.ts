import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableOrganizationRls } from '../../shared/infra/db/migration-helpers.js';

// Orçamento mensal de IA por organização (spec active-cloud §4.4; módulo cloud + organizations):
// - `organizations.ai_budget_micro_usd`: orçamento do mês em micro-USD, padrão 0 (a nuvem ativa é contratada; o
//   financeiro da plataforma ajusta). `ADD COLUMN ... DEFAULT` não reescreve linhas nem dispara o trigger do
//   sync_version; a sincronização do Hub projeta colunas explícitas e nunca leva o orçamento.
// - `cloud_ai_reservations`: uma linha por chamada que custa (reserva -> acerto/devolução/expiração). Só ids, tipo,
//   modelo, tokens e custos. RLS por organização; o runtime tem SELECT/INSERT/UPDATE (sem DELETE: é o histórico).
// - `cloud_ai_usage`: o gasto acertado do mês por espaço e tipo (somado a cada acerto). RLS por organização.
// - `ix_cloud_files_pending`: os espaços com arquivo `pending` (retomar a indexação quando o orçamento sobe).
// Mês = mês civil UTC pelo relógio do banco.
export class CreateCloudAiBudget1792898000000 implements MigrationInterface {
  name = 'CreateCloudAiBudget1792898000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "cloud_ai_reservations" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "organization_id" uuid NOT NULL,
                "space_id" uuid NOT NULL,
                "kind" character varying(20) NOT NULL,
                "month" date NOT NULL,
                "amount_micro_usd" bigint NOT NULL,
                "status" character varying(20) NOT NULL DEFAULT 'reserved',
                "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
                "settled_at" TIMESTAMP WITH TIME ZONE,
                "model" character varying(100),
                "input_tokens" bigint,
                "output_tokens" bigint,
                "cost_micro_usd" bigint,
                CONSTRAINT "ck_cloud_ai_reservations_spend" CHECK (
                    "cost_micro_usd" >= 0
                    AND "input_tokens" >= 0
                    AND "output_tokens" >= 0
                ),
                CONSTRAINT "ck_cloud_ai_reservations_settled" CHECK (
                    ("status" = 'settled') = ("settled_at" IS NOT NULL)
                    AND ("settled_at" IS NULL) = ("cost_micro_usd" IS NULL)
                    AND ("settled_at" IS NULL) = ("model" IS NULL)
                    AND ("settled_at" IS NULL) = ("input_tokens" IS NULL)
                    AND ("settled_at" IS NULL) = ("output_tokens" IS NULL)
                ),
                CONSTRAINT "ck_cloud_ai_reservations_amount" CHECK ("amount_micro_usd" >= 0),
                CONSTRAINT "ck_cloud_ai_reservations_status" CHECK (
                    "status" IN ('reserved', 'settled', 'released', 'expired')
                ),
                CONSTRAINT "ck_cloud_ai_reservations_kind" CHECK ("kind" IN ('answer', 'indexing')),
                CONSTRAINT "PK_208b0914deeecbb7fc05cf04a5a" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_ai_reservations_organizations_idx" ON "cloud_ai_reservations" ("organization_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_ai_reservations_spaces_idx" ON "cloud_ai_reservations" ("space_id", "organization_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "ix_cloud_ai_reservations_live" ON "cloud_ai_reservations" ("organization_id", "month")
            WHERE "status" = 'reserved'
        `);
    await queryRunner.query(`
            CREATE TABLE "cloud_ai_usage" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "organization_id" uuid NOT NULL,
                "space_id" uuid NOT NULL,
                "kind" character varying(20) NOT NULL,
                "month" date NOT NULL,
                "cost_micro_usd" bigint NOT NULL DEFAULT '0',
                "input_tokens" bigint NOT NULL DEFAULT '0',
                "output_tokens" bigint NOT NULL DEFAULT '0',
                "calls" integer NOT NULL DEFAULT '0',
                CONSTRAINT "uq_cloud_ai_usage_month_space_kind" UNIQUE ("organization_id", "month", "space_id", "kind"),
                CONSTRAINT "ck_cloud_ai_usage_counts" CHECK (
                    "cost_micro_usd" >= 0
                    AND "input_tokens" >= 0
                    AND "output_tokens" >= 0
                    AND "calls" >= 0
                ),
                CONSTRAINT "ck_cloud_ai_usage_kind" CHECK ("kind" IN ('answer', 'indexing')),
                CONSTRAINT "PK_6928a332e8a8f17a418c497601e" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_ai_usage_spaces_idx" ON "cloud_ai_usage" ("space_id", "organization_id")
        `);
    for (const table of ['cloud_ai_reservations', 'cloud_ai_usage']) {
      await enableOrganizationRls(queryRunner, table);
    }
    await queryRunner.query(`
            ALTER TABLE "organizations"
            ADD "ai_budget_micro_usd" bigint NOT NULL DEFAULT '0'
        `);
    await queryRunner.query(`
            CREATE INDEX "ix_cloud_files_pending" ON "cloud_files" ("organization_id", "space_id")
            WHERE "status" = 'pending'
        `);
    await queryRunner.query(`
            ALTER TABLE "organizations"
            ADD CONSTRAINT "ck_organizations_ai_budget_micro_usd" CHECK ("ai_budget_micro_usd" >= 0)
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_reservations"
            ADD CONSTRAINT "fk_cloud_ai_reservations_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_reservations"
            ADD CONSTRAINT "fk_cloud_ai_reservations_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_usage"
            ADD CONSTRAINT "fk_cloud_ai_usage_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_usage"
            ADD CONSTRAINT "fk_cloud_ai_usage_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_usage" DROP CONSTRAINT "fk_cloud_ai_usage_spaces"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_usage" DROP CONSTRAINT "fk_cloud_ai_usage_organizations"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_reservations" DROP CONSTRAINT "fk_cloud_ai_reservations_spaces"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_ai_reservations" DROP CONSTRAINT "fk_cloud_ai_reservations_organizations"
        `);
    await queryRunner.query(`
            ALTER TABLE "organizations" DROP CONSTRAINT "ck_organizations_ai_budget_micro_usd"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."ix_cloud_files_pending"
        `);
    await queryRunner.query(`
            ALTER TABLE "organizations" DROP COLUMN "ai_budget_micro_usd"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_ai_usage_spaces_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_ai_usage"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."ix_cloud_ai_reservations_live"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_ai_reservations_spaces_idx"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_ai_reservations_organizations_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_ai_reservations"
        `);
  }
}
