import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  addSyncVersionTrigger,
  dropSyncVersionTrigger,
} from '../../shared/infra/db/migration-helpers.js';

export class CreateUsersAndSessions1792894061160 implements MigrationInterface {
  name = 'CreateUsersAndSessions1792894061160';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "users" (
        "id" uuid NOT NULL DEFAULT uuidv7(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "name" character varying(255) NOT NULL,
        "email" character varying(255) NOT NULL,
        "auth_hash" character varying(255) NOT NULL,
        "kdf_salt" character varying(64) NOT NULL,
        "kdf_params" jsonb NOT NULL,
        "public_key" text NOT NULL,
        "encrypted_private_key" text NOT NULL,
        CONSTRAINT "PK_users" PRIMARY KEY ("id")
      )
    `);
    // Único só entre usuários ativos: o e-mail de uma conta excluída (lápide) pode ser reaproveitado.
    await queryRunner.query(`
      CREATE UNIQUE INDEX "uq_users_email" ON "users" ("email") WHERE "deleted_at" IS NULL
    `);
    await addSyncVersionTrigger(queryRunner, 'users');

    await queryRunner.query(`
      CREATE TABLE "user_sessions" (
        "id" uuid NOT NULL DEFAULT uuidv7(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE DEFAULT now(),
        "deleted_at" TIMESTAMP WITH TIME ZONE,
        "user_id" uuid NOT NULL,
        "device_name" character varying(100) NOT NULL,
        "device_platform" character varying(20) NOT NULL DEFAULT 'other',
        "refresh_token_hash" character varying(128) NOT NULL,
        "refresh_expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "last_used_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "last_ip" character varying(45),
        "user_agent" character varying(500),
        "revoked_at" TIMESTAMP WITH TIME ZONE,
        "revoked_reason" character varying(20),
        CONSTRAINT "PK_user_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "ck_user_sessions_device_platform"
          CHECK ("device_platform" IN ('android', 'ios', 'hub', 'web', 'other')),
        CONSTRAINT "ck_user_sessions_revoked_reason"
          CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN ('logout', 'revoked', 'refresh_reuse', 'password_change')),
        CONSTRAINT "fk_user_sessions_users" FOREIGN KEY ("user_id") REFERENCES "users" ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX "ix_user_sessions_user" ON "user_sessions" ("user_id", "revoked_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "ix_user_sessions_user"`);
    await queryRunner.query(`DROP TABLE "user_sessions"`);
    await dropSyncVersionTrigger(queryRunner, 'users');
    await queryRunner.query(`DROP INDEX "uq_users_email"`);
    await queryRunner.query(`DROP TABLE "users"`);
  }
}
