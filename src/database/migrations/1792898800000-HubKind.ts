import { MigrationInterface, QueryRunner } from 'typeorm';

// `kind` do Hub (spec pc-agent §5.1): `appliance` (o Raspberry Pi) ou `pc` (um PC agindo como Hub). Declarado na
// apresentação (`hub-enroll-v2`), copiado para o Hub no claim e imutável: `hubs` tem GRANT de UPDATE por coluna
// (HardenHubsRls) e `kind` fica FORA da lista. Linhas existentes são `appliance` (o padrão). `ADD COLUMN ... DEFAULT`
// não reescreve linhas nem dispara o trigger do sync_version.
export class HubKind1792898800000 implements MigrationInterface {
  name = 'HubKind1792898800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "hub_enrollments"
        ADD COLUMN "kind" character varying(16) NOT NULL DEFAULT 'appliance',
        ADD CONSTRAINT "ck_hub_enrollments_kind" CHECK ("kind" IN ('appliance', 'pc'))
    `);
    await queryRunner.query(`
      ALTER TABLE "hubs"
        ADD COLUMN "kind" character varying(16) NOT NULL DEFAULT 'appliance',
        ADD CONSTRAINT "ck_hubs_kind" CHECK ("kind" IN ('appliance', 'pc'))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "hubs"
        DROP CONSTRAINT "ck_hubs_kind",
        DROP COLUMN "kind"
    `);
    await queryRunner.query(`
      ALTER TABLE "hub_enrollments"
        DROP CONSTRAINT "ck_hub_enrollments_kind",
        DROP COLUMN "kind"
    `);
  }
}
