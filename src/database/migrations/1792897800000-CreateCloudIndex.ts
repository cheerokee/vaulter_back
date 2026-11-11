import { MigrationInterface, QueryRunner } from 'typeorm';
import { enableOrganizationRls } from '../../shared/infra/db/migration-helpers.js';

// Índice da nuvem ativa (spec active-cloud §4.2; módulo cloud; contrato do manifesto em docs/hubs/space-manifest.md):
// - `cloud_files`: os arquivos de um espaço em nuvem ativa como os manifestos os descrevem (nome, caminho, tipo, origem:
//   LEGÍVEIS) e as versões do backup de cada parte já indexadas ou a indexar;
// - `cloud_chunks`: trechos (texto LEGÍVEL), `embedding vector(768)` (`nomic-embed-text`, o modelo gravado em cada
//   linha) e índice HNSW por cosseno (`vector_cosine_ops`; fora dos metadados da entidade, `synchronize: false`).
// Desligar a nuvem APAGA as duas de verdade (os trechos também em cascata pelo arquivo), então o runtime tem DELETE
// nelas: exceção documentada à regra do soft delete, como `cloud_space_key_grants`. RLS por organização nas duas.

export class CreateCloudIndex1792897800000 implements MigrationInterface {
  name = 'CreateCloudIndex1792897800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "cloud_chunks" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "organization_id" uuid NOT NULL,
                "space_id" uuid NOT NULL,
                "cloud_file_id" uuid NOT NULL,
                "file_id" uuid NOT NULL,
                "object_id" uuid NOT NULL,
                "version_id" uuid NOT NULL,
                "position" integer NOT NULL,
                "text" text NOT NULL,
                "embedding" vector(768) NOT NULL,
                "embedding_model" character varying(100) NOT NULL,
                CONSTRAINT "ck_cloud_chunks_position" CHECK ("position" >= 0),
                CONSTRAINT "PK_18b25998a55e69d63a66b99c535" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_chunks_organizations_idx" ON "cloud_chunks" ("organization_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_chunks_spaces_idx" ON "cloud_chunks" ("space_id", "organization_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_chunks_files_idx" ON "cloud_chunks" ("cloud_file_id", "organization_id")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_cloud_chunks_file_position" ON "cloud_chunks" ("cloud_file_id", "position")
        `);
    await queryRunner.query(`
            CREATE TABLE "cloud_files" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "organization_id" uuid NOT NULL,
                "space_id" uuid NOT NULL,
                "file_id" uuid NOT NULL,
                "manifest" character varying(10) NOT NULL,
                "name" character varying(255) NOT NULL,
                "path" character varying(1024),
                "media_type" character varying(255) NOT NULL,
                "source_kind" character varying(20) NOT NULL,
                "connector" character varying(100),
                "modified_at" TIMESTAMP WITH TIME ZONE,
                "part_object_ids" uuid array NOT NULL,
                "part_version_ids" uuid array NOT NULL,
                "status" character varying(20) NOT NULL,
                "skip_reason" character varying(40),
                "embedding_model" character varying(100),
                "chunk_count" integer NOT NULL DEFAULT '0',
                "indexed_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "uq_cloud_files_id_organization" UNIQUE ("id", "organization_id"),
                CONSTRAINT "ck_cloud_files_chunk_count" CHECK ("chunk_count" >= 0),
                CONSTRAINT "ck_cloud_files_parts" CHECK (
                    cardinality("part_object_ids") = cardinality("part_version_ids")
                ),
                CONSTRAINT "ck_cloud_files_skip_reason" CHECK (
                    ("status" = 'skipped') = ("skip_reason" IS NOT NULL)
                ),
                CONSTRAINT "ck_cloud_files_connector" CHECK (
                    ("source_kind" = 'connector') = ("connector" IS NOT NULL)
                ),
                CONSTRAINT "ck_cloud_files_source_kind" CHECK ("source_kind" IN ('file', 'connector', 'cloud')),
                CONSTRAINT "ck_cloud_files_manifest" CHECK ("manifest" IN ('hub', 'cloud')),
                CONSTRAINT "ck_cloud_files_status" CHECK ("status" IN ('pending', 'indexed', 'skipped')),
                CONSTRAINT "PK_a91b794c1dae9b744297d9e370a" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_files_organizations_idx" ON "cloud_files" ("organization_id")
        `);
    await queryRunner.query(`
            CREATE INDEX "fk_cloud_files_spaces_idx" ON "cloud_files" ("space_id", "organization_id")
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_cloud_files_space_file" ON "cloud_files" ("space_id", "file_id")
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_chunks"
            ADD CONSTRAINT "fk_cloud_chunks_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_chunks"
            ADD CONSTRAINT "fk_cloud_chunks_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_chunks"
            ADD CONSTRAINT "fk_cloud_chunks_files" FOREIGN KEY ("cloud_file_id", "organization_id") REFERENCES "cloud_files"("id", "organization_id") ON DELETE CASCADE ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_files"
            ADD CONSTRAINT "fk_cloud_files_organizations" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_files"
            ADD CONSTRAINT "fk_cloud_files_spaces" FOREIGN KEY ("space_id", "organization_id") REFERENCES "spaces"("id", "organization_id") ON DELETE NO ACTION ON UPDATE NO ACTION
        `);
    // Busca por similaridade (cosseno) dos trechos; m/ef_construction padrão do pgvector.
    await queryRunner.query(`
            CREATE INDEX "ix_cloud_chunks_embedding_hnsw" ON "cloud_chunks" USING hnsw ("embedding" vector_cosine_ops)
        `);
    for (const table of ['cloud_files', 'cloud_chunks']) {
      await enableOrganizationRls(queryRunner, table);
      await queryRunner.query(`GRANT DELETE ON "${table}" TO app_runtime`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."ix_cloud_chunks_embedding_hnsw"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_files" DROP CONSTRAINT "fk_cloud_files_spaces"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_files" DROP CONSTRAINT "fk_cloud_files_organizations"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_chunks" DROP CONSTRAINT "fk_cloud_chunks_files"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_chunks" DROP CONSTRAINT "fk_cloud_chunks_spaces"
        `);
    await queryRunner.query(`
            ALTER TABLE "cloud_chunks" DROP CONSTRAINT "fk_cloud_chunks_organizations"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."uq_cloud_files_space_file"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_files_spaces_idx"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_files_organizations_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_files"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."uq_cloud_chunks_file_position"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_chunks_files_idx"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_chunks_spaces_idx"
        `);
    await queryRunner.query(`
            DROP INDEX "public"."fk_cloud_chunks_organizations_idx"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_chunks"
        `);
  }
}
