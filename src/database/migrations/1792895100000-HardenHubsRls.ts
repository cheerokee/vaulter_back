import { MigrationInterface, QueryRunner } from 'typeorm';

const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;

const MEMBER_OF = (orgColumn: string) => `EXISTS (
  SELECT 1 FROM user_organization uo
   WHERE uo.organization_id = ${orgColumn}
     AND uo.user_id = ${USER}
     AND uo.deleted_at IS NULL)`;

// Atribuição de escopo hub da dona (como na CreateHubs).
const HUB_OWNER = `scope_type = 'hub' AND EXISTS (
     SELECT 1 FROM hubs h WHERE h.id = role_assignments.hub_id AND h.owner_user_id = ${USER})`;
// O Hub (ou uma cascata no contexto dele) só alcança papéis atribuíveis (hub_operator, hub_user), nunca hub_owner
// nem hub_room.
const THE_HUB_ASSIGNABLE = `scope_type = 'hub' AND hub_id = ${HUB} AND role_id IN (
     SELECT r.id FROM roles r
      WHERE r.organization_id IS NULL AND r.scope_type = 'hub' AND r.key IN ('hub_operator', 'hub_user'))`;
const THE_HUB = `scope_type = 'hub' AND hub_id = ${HUB}`;

// Endurece o RLS e as guardas da CreateHubs (revisão da Task 5). Matriz resultante:
//
// | Tabela | SELECT | INSERT | UPDATE |
// |---|---|---|---|
// | hubs | (igual) | (igual) | (igual), mas o runtime só tem UPDATE nas colunas name, last_seen_at, deleted_at e updated_at |
// | hub_organization | org_isolation; membro ativo, só vínculo `approved` sem lápide; dono do Hub; o Hub, só `approved`/`revoked` | org_isolation | org_isolation |
// | hub_space | org_isolation; dono do Hub; o Hub, só com vínculo `approved` sem lápide da organização da linha | org_isolation | org_isolation |
// | role_assignments, escopo hub | (igual) | dono do Hub | dono do Hub; o Hub só grava lápide em papel atribuível |
//
// - hub_space ganha FK composta (hub_id, organization_id) -> hub_organization (PK): só entra espaço de organização
//   com vínculo (qualquer status) com o Hub; a policy do Hub ainda exige o vínculo aprovado. Sem recursão: a
//   policy de hub_space consulta hub_organization, cujas policies não consultam hub_space nem hubs.
// - hub_space perde a leitura por membro (nenhum caso de uso precisa: o Gestor age com o escopo da organização,
//   o dono lê pela policy dele).
// - O Hub só vê vínculos `approved` e `revoked` (a sincronização manda o revogado como lápide); pendente e
//   recusado não.
// - Escopo hub em role_assignments: no ramo do Hub, a linha nova precisa ter lápide (WITH CHECK) e papel atribuível
//   (USING e WITH CHECK). O WITH CHECK não compara com a linha antiga: na mesma UPDATE que grava a lápide, o Hub
//   poderia trocar o papel para outro atribuível ou o user_id; aceito, porque uma linha com lápide não dá nada e
//   reviver exige o ramo da dona (que reescreve o papel).
// - hub_organization: quem consente como dono é sempre o dono do Hub (CHECK).
// - hub_link_codes: o único parcial passa a ignorar lápides; expireStale grava lápide nos vencidos não usados e
//   libera o hash (antes um vencido segurava o hash até ser usado, o que nunca acontece).
// - hubs: dono e chaves imutáveis para o runtime (privilégio de UPDATE só nas colunas que os casos de uso mudam;
//   sync_version vem do trigger BEFORE, que não exige privilégio de coluna).
export class HardenHubsRls1792895100000 implements MigrationInterface {
  name = 'HardenHubsRls1792895100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // hub_space: vínculo obrigatório e leitura do Hub só com vínculo aprovado.
    await queryRunner.query(
      `ALTER TABLE "hub_space" ADD CONSTRAINT "fk_hub_space_hub_organization" FOREIGN KEY ("hub_id", "organization_id") REFERENCES "hub_organization" ("hub_id", "organization_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "fk_hub_space_hub_organization_idx" ON "hub_space" ("hub_id", "organization_id")`,
    );
    await queryRunner.query(`DROP POLICY "member_read" ON "hub_space"`);
    await queryRunner.query(`DROP POLICY "hub_read" ON "hub_space"`);
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_space" FOR SELECT USING (
         hub_id = ${HUB} AND EXISTS (
           SELECT 1 FROM hub_organization ho
            WHERE ho.hub_id = hub_space.hub_id
              AND ho.organization_id = hub_space.organization_id
              AND ho.status = 'approved'
              AND ho.deleted_at IS NULL))`,
    );

    // hub_organization: leituras mais estreitas e o consentimento do dono só pelo dono.
    await queryRunner.query(`DROP POLICY "member_read" ON "hub_organization"`);
    await queryRunner.query(
      `CREATE POLICY "member_read" ON "hub_organization" FOR SELECT USING (
         status = 'approved' AND deleted_at IS NULL AND ${MEMBER_OF('hub_organization.organization_id')})`,
    );
    await queryRunner.query(`DROP POLICY "hub_read" ON "hub_organization"`);
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_organization" FOR SELECT USING (
         hub_id = ${HUB} AND status IN ('approved', 'revoked'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "hub_organization" ADD CONSTRAINT "ck_hub_organization_owner_approver" CHECK ("owner_approved_by_user_id" IS NULL OR "owner_approved_by_user_id" = "hub_owner_user_id")`,
    );

    // role_assignments, escopo hub: o Hub só grava lápide em papel atribuível.
    await queryRunner.query(
      `DROP POLICY "hub_scope_update" ON "role_assignments"`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_scope_update" ON "role_assignments" FOR UPDATE
         USING ((${HUB_OWNER}) OR (${THE_HUB_ASSIGNABLE}))
         WITH CHECK ((${HUB_OWNER}) OR ((${THE_HUB_ASSIGNABLE}) AND deleted_at IS NOT NULL))`,
    );

    // hub_link_codes: lápide libera o hash.
    await queryRunner.query(`DROP INDEX "uq_hub_link_codes_code_hash"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hub_link_codes_code_hash" ON "hub_link_codes" ("code_hash") WHERE "used_at" IS NULL AND "deleted_at" IS NULL`,
    );

    // hubs: UPDATE só nas colunas mutáveis.
    await queryRunner.query(`REVOKE UPDATE ON "hubs" FROM app_runtime`);
    await queryRunner.query(
      `GRANT UPDATE ("name", "last_seen_at", "deleted_at", "updated_at") ON "hubs" TO app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `REVOKE UPDATE ("name", "last_seen_at", "deleted_at", "updated_at") ON "hubs" FROM app_runtime`,
    );
    await queryRunner.query(`GRANT UPDATE ON "hubs" TO app_runtime`);

    await queryRunner.query(`DROP INDEX "uq_hub_link_codes_code_hash"`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "uq_hub_link_codes_code_hash" ON "hub_link_codes" ("code_hash") WHERE "used_at" IS NULL`,
    );

    await queryRunner.query(
      `DROP POLICY "hub_scope_update" ON "role_assignments"`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_scope_update" ON "role_assignments" FOR UPDATE
         USING ((${HUB_OWNER}) OR (${THE_HUB}))
         WITH CHECK ((${HUB_OWNER}) OR (${THE_HUB}))`,
    );

    await queryRunner.query(
      `ALTER TABLE "hub_organization" DROP CONSTRAINT "ck_hub_organization_owner_approver"`,
    );
    await queryRunner.query(`DROP POLICY "hub_read" ON "hub_organization"`);
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_organization" FOR SELECT USING (hub_id = ${HUB})`,
    );
    await queryRunner.query(`DROP POLICY "member_read" ON "hub_organization"`);
    await queryRunner.query(
      `CREATE POLICY "member_read" ON "hub_organization" FOR SELECT USING (${MEMBER_OF('hub_organization.organization_id')})`,
    );

    await queryRunner.query(`DROP POLICY "hub_read" ON "hub_space"`);
    await queryRunner.query(
      `CREATE POLICY "hub_read" ON "hub_space" FOR SELECT USING (hub_id = ${HUB})`,
    );
    await queryRunner.query(
      `CREATE POLICY "member_read" ON "hub_space" FOR SELECT USING (${MEMBER_OF('hub_space.organization_id')})`,
    );
    await queryRunner.query(`DROP INDEX "fk_hub_space_hub_organization_idx"`);
    await queryRunner.query(
      `ALTER TABLE "hub_space" DROP CONSTRAINT "fk_hub_space_hub_organization"`,
    );
  }
}
