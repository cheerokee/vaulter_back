import { MigrationInterface, QueryRunner } from 'typeorm';

const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;

// O Hub lê TODAS as próprias linhas de hub_organization, de qualquer status (substitui a regra da HardenHubsRls,
// que só mostrava approved/revoked). Motivo: desvincular e pedir de novo reaproveita a linha (revoked -> pending ->
// talvez rejected); com a regra antiga o Hub nunca via a saída e guardava os dados da organização para sempre. A
// sincronização manda todo vínculo não aprovado como lápide (só as chaves). hub_space continua só de vínculo aprovado.
export class HubReadsAllOwnLinks1792895300000 implements MigrationInterface {
  name = 'HubReadsAllOwnLinks1792895300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY "hub_read" ON "hub_organization"`);
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_organization" FOR SELECT USING (hub_id = ${HUB})`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP POLICY "hub_read" ON "hub_organization"`);
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_organization" FOR SELECT USING (
         hub_id = ${HUB} AND status IN ('approved', 'revoked'))`,
    );
  }
}
