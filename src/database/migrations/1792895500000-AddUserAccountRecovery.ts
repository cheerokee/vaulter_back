import { MigrationInterface, QueryRunner } from 'typeorm';

// Spec de recuperação de conta §4.1/§4.2: o cadastro passa a exigir o material do código de recuperação.
// `recovery_hash` = hash com chave (BLAKE2b, `IDENTITY_RECOVERY_HASH_KEY`) da prova do código, em hex;
// `recovery_encrypted_private_key` = a chave privada trancada pelo código (formato em docs/crypto/user-keys.md).
// NOT NULL sem default: não há usuários anteriores a esta migration fora de desenvolvimento.
// Recuperar a conta revoga todas as sessões com o motivo `account_recovery`.
export class AddUserAccountRecovery1792895500000 implements MigrationInterface {
  name = 'AddUserAccountRecovery1792895500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "recovery_hash" character varying(64) NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN "recovery_encrypted_private_key" text NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" DROP CONSTRAINT "ck_user_sessions_revoked_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" ADD CONSTRAINT "ck_user_sessions_revoked_reason"
        CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN ('logout', 'revoked', 'refresh_reuse', 'password_change', 'account_recovery'))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "user_sessions" SET "revoked_reason" = 'revoked' WHERE "revoked_reason" = 'account_recovery'`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" DROP CONSTRAINT "ck_user_sessions_revoked_reason"`,
    );
    await queryRunner.query(
      `ALTER TABLE "user_sessions" ADD CONSTRAINT "ck_user_sessions_revoked_reason"
        CHECK ("revoked_reason" IS NULL OR "revoked_reason" IN ('logout', 'revoked', 'refresh_reuse', 'password_change'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "recovery_encrypted_private_key"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "recovery_hash"`);
  }
}
