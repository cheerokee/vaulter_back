import { MigrationInterface, QueryRunner } from 'typeorm';

// Par X25519 do servidor (módulo cloud, nuvem ativa): pública em claro, privada só cifrada pelo KMS (KmsServerKeyring).
// Dado do servidor (sem organization_id nem RLS; nenhuma rota lista a tabela, só a pública sai por GET
// /cloud/server-key). O runtime grava a linha nova (INSERT dos default privileges) e só pode mudar `retired_at` /
// `updated_at` (aposentar numa rotação): a pública e a cópia cifrada são imutáveis.

export class CreateCloudServerKeys1792897600000 implements MigrationInterface {
  name = 'CreateCloudServerKeys1792897600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            CREATE TABLE "cloud_server_keys" (
                "id" uuid NOT NULL DEFAULT uuidv7(),
                "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
                "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
                "deleted_at" TIMESTAMP WITH TIME ZONE,
                "public_key" character varying(43) NOT NULL,
                "encrypted_private_key" text NOT NULL,
                "kms_key_arn" character varying(2048) NOT NULL,
                "retired_at" TIMESTAMP WITH TIME ZONE,
                CONSTRAINT "chk_cloud_server_keys_public_key" CHECK (char_length("public_key") = 43),
                CONSTRAINT "PK_afe1c0bedb73b0b78227b5c470e" PRIMARY KEY ("id")
            )
        `);
    await queryRunner.query(`
            CREATE UNIQUE INDEX "uq_cloud_server_keys_public_key" ON "cloud_server_keys" ("public_key")
        `);
    await queryRunner.query(
      `REVOKE UPDATE ON "cloud_server_keys" FROM app_runtime`,
    );
    await queryRunner.query(
      `GRANT UPDATE ("retired_at", "updated_at") ON "cloud_server_keys" TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
            DROP INDEX "public"."uq_cloud_server_keys_public_key"
        `);
    await queryRunner.query(`
            DROP TABLE "cloud_server_keys"
        `);
  }
}
