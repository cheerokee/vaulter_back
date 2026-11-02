import { MigrationInterface, QueryRunner } from 'typeorm';

// Spec hubs §5: `hub_enrollments.signing_public_key` é única entre as apresentações PENDENTES. Uma apresentação
// nova da mesma chave (o aparelho reiniciou antes de ser reivindicado) expira a anterior antes de gravar
// (EnrollHubUseCase); o índice é a trava contra a corrida entre duas apresentações simultâneas.
// Antes de criar o índice, as pendentes repetidas que já existam viram `expired`, menos a mais nova de cada chave.
export class UniquePendingEnrollmentKey1792895400000 implements MigrationInterface {
  name = 'UniquePendingEnrollmentKey1792895400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "hub_enrollments" e SET "status" = 'expired', "updated_at" = now()
        WHERE e."status" = 'pending'
          AND EXISTS (
            SELECT 1 FROM "hub_enrollments" newer
             WHERE newer."signing_public_key" = e."signing_public_key"
               AND newer."status" = 'pending'
               AND (newer."created_at", newer."id") > (e."created_at", e."id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hub_enrollments_pending_signing_key" ON "hub_enrollments" ("signing_public_key") WHERE "status" = 'pending'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "uq_hub_enrollments_pending_signing_key"`,
    );
  }
}
