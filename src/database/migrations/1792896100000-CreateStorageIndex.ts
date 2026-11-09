import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  disableOrganizationRls,
  enableOrganizationRls,
} from '../../shared/infra/db/migration-helpers.js';

const COMMON = `
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE`;

// Índice do backup cifrado dos espaços (spec storage-backup §4.1, §4.2; módulo `storage`):
// - `storage_objects`: um objeto por `objectId` gerado pelo Hub (sem default); `current_version_id` = a última versão
//   confirmada (fica depois do apagar, para a lixeira); lápide = apagado.
// - `storage_object_versions`: uma linha por intenção de envio (id uuid v7 do servidor = `uploadId`); `pending`
//   (reserva o tamanho até `upload_expires_at`), `committed` (com `s3_version_id` e `committed_at`) ou `expired`;
//   `superseded_at` = foi para a lixeira (30 dias). Quem enviou: um Hub OU uma pessoa (CHECK num_nonnulls).
// - Só ids, tamanho, sha256 do blob cifrado, versão da chave e datas: NUNCA nome, tipo ou caminho de arquivo.
// - Dado de cliente: `organization_id` e RLS por organização (`org_isolation`, ENABLE + FORCE). O runtime fica com os
//   default privileges (SELECT, INSERT, UPDATE; sem DELETE): a limpeza física depois da lixeira é rotina com o dono.
// - FKs compostas (filho, organization_id) -> (pai.id, pai.organization_id) para espaço, objeto, versão substituída e
//   versão atual (a checagem de FK ignora o RLS). As duas tabelas se referenciam: as FKs entram depois das tabelas.
// - Sem sync_version: o índice não entra na sincronização do Hub (ele lista pelo endpoint do índice, Task 7).
export class CreateStorageIndex1792896100000 implements MigrationInterface {
  name = 'CreateStorageIndex1792896100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "storage_objects" (
        "id" uuid NOT NULL,${COMMON},
        "organization_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "current_version_id" uuid,
        CONSTRAINT "PK_storage_objects" PRIMARY KEY ("id"),
        CONSTRAINT "uq_storage_objects_id_organization" UNIQUE ("id", "organization_id")
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "storage_object_versions" (
        "id" uuid NOT NULL DEFAULT uuidv7(),${COMMON},
        "organization_id" uuid NOT NULL,
        "space_id" uuid NOT NULL,
        "object_id" uuid NOT NULL,
        "key_version" integer NOT NULL,
        "size_bytes" bigint NOT NULL,
        "sha256" character(64) NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'pending',
        "replaces_version_id" uuid,
        "s3_version_id" character varying(1024),
        "uploaded_by_hub_id" uuid,
        "uploaded_by_user_id" uuid,
        "upload_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "committed_at" TIMESTAMP WITH TIME ZONE,
        "superseded_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_storage_object_versions" PRIMARY KEY ("id"),
        CONSTRAINT "uq_storage_object_versions_id_organization" UNIQUE ("id", "organization_id"),
        CONSTRAINT "ck_storage_object_versions_status" CHECK ("status" IN ('pending', 'committed', 'expired')),
        CONSTRAINT "ck_storage_object_versions_uploader" CHECK (num_nonnulls("uploaded_by_hub_id", "uploaded_by_user_id") = 1),
        CONSTRAINT "ck_storage_object_versions_size_bytes" CHECK ("size_bytes" > 0),
        CONSTRAINT "ck_storage_object_versions_key_version" CHECK ("key_version" >= 1),
        CONSTRAINT "ck_storage_object_versions_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$'),
        CONSTRAINT "ck_storage_object_versions_committed" CHECK (("status" = 'committed') = ("s3_version_id" IS NOT NULL AND "committed_at" IS NOT NULL))
      )
    `);

    for (const [table, name, columns] of [
      [
        'storage_objects',
        'fk_storage_objects_organizations_idx',
        '"organization_id"',
      ],
      ['storage_objects', 'fk_storage_objects_spaces_idx', '"space_id"'],
      [
        'storage_objects',
        'fk_storage_objects_current_version_idx',
        '"current_version_id"',
      ],
      [
        'storage_object_versions',
        'fk_storage_object_versions_organizations_idx',
        '"organization_id"',
      ],
      [
        'storage_object_versions',
        'fk_storage_object_versions_objects_idx',
        '"object_id"',
      ],
      [
        'storage_object_versions',
        'fk_storage_object_versions_replaces_idx',
        '"replaces_version_id"',
      ],
      [
        'storage_object_versions',
        'fk_storage_object_versions_hubs_idx',
        '"uploaded_by_hub_id"',
      ],
      [
        'storage_object_versions',
        'fk_storage_object_versions_users_idx',
        '"uploaded_by_user_id"',
      ],
      // Uso do espaço (soma por status).
      [
        'storage_object_versions',
        'ix_storage_object_versions_space_status',
        '"space_id", "status"',
      ],
    ]) {
      await queryRunner.query(
        `CREATE INDEX "${name}" ON "${table}" (${columns})`,
      );
    }

    for (const sql of [
      `ALTER TABLE "storage_objects" ADD CONSTRAINT "fk_storage_objects_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "storage_objects" ADD CONSTRAINT "fk_storage_objects_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces" ("id", "organization_id")`,
      `ALTER TABLE "storage_objects" ADD CONSTRAINT "fk_storage_objects_current_version" FOREIGN KEY ("current_version_id", "organization_id") REFERENCES "storage_object_versions" ("id", "organization_id")`,
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "fk_storage_object_versions_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations" ("id")`,
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "fk_storage_object_versions_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces" ("id", "organization_id")`,
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "fk_storage_object_versions_objects" FOREIGN KEY ("object_id", "organization_id") REFERENCES "storage_objects" ("id", "organization_id")`,
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "fk_storage_object_versions_replaces" FOREIGN KEY ("replaces_version_id", "organization_id") REFERENCES "storage_object_versions" ("id", "organization_id")`,
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "fk_storage_object_versions_hubs" FOREIGN KEY ("uploaded_by_hub_id") REFERENCES "hubs" ("id")`,
      `ALTER TABLE "storage_object_versions" ADD CONSTRAINT "fk_storage_object_versions_users" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users" ("id")`,
    ]) {
      await queryRunner.query(sql);
    }

    for (const table of ['storage_objects', 'storage_object_versions']) {
      await enableOrganizationRls(queryRunner, table);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['storage_object_versions', 'storage_objects']) {
      await disableOrganizationRls(queryRunner, table);
    }
    await queryRunner.query(
      `ALTER TABLE "storage_objects" DROP CONSTRAINT "fk_storage_objects_current_version"`,
    );
    await queryRunner.query(`DROP TABLE "storage_object_versions"`);
    await queryRunner.query(`DROP TABLE "storage_objects"`);
  }
}
