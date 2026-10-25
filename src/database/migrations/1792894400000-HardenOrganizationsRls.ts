import { MigrationInterface, QueryRunner } from 'typeorm';

const ORG = `NULLIF(current_setting('app.organization_id', true), '')::uuid`;
const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const TOKEN = `NULLIF(current_setting('app.invitation_token_hash', true), '')`;

// RLS sem funções SECURITY DEFINER: tudo é avaliado com o papel de quem consulta (app_runtime), então o
// isolamento não depende de o dono das tabelas ser superusuário (num Postgres gerenciado ele não é, e o
// FORCE RLS faria a função do dono não enxergar nada).
// - organizations: leitura com `id = app.organization_id` ou EXISTS em user_organization do `app.user_id`
//   (o subselect passa pela policy self_read de user_organization, que não referencia organizations: sem
//   recursão). UPDATE só com `id = app.organization_id` (save() sempre põe o contexto).
// - organization_invitations: leitura do convite cujo token_hash = `app.invitation_token_hash` (prévia e
//   aceite antes de haver organização no contexto).
// - Catálogo RBAC (permissions, permission_dependency, role_permission) passa a ser só leitura para o
//   runtime. Papéis próprios (modo avançado) vão precisar de escrita em role_permission com RLS por
//   organização; entra junto com essa funcionalidade.
export class HardenOrganizationsRls1792894400000 implements MigrationInterface {
  name = 'HardenOrganizationsRls1792894400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY "org_member_select" ON "organizations"`,
    );
    await queryRunner.query(
      `DROP POLICY "org_member_update" ON "organizations"`,
    );
    await queryRunner.query(
      `CREATE POLICY "org_member_select" ON "organizations" FOR SELECT USING (
         id = ${ORG} OR EXISTS (
           SELECT 1 FROM user_organization uo
            WHERE uo.organization_id = organizations.id
              AND uo.user_id = ${USER}
              AND uo.deleted_at IS NULL))`,
    );
    await queryRunner.query(
      `CREATE POLICY "org_update" ON "organizations" FOR UPDATE USING (id = ${ORG}) WITH CHECK (id = ${ORG})`,
    );
    await queryRunner.query(`DROP FUNCTION app_is_member(uuid)`);

    await queryRunner.query(
      `CREATE POLICY "invitation_by_token" ON "organization_invitations" FOR SELECT USING (token_hash = ${TOKEN})`,
    );
    await queryRunner.query(`DROP FUNCTION app_find_invitation(text)`);

    await queryRunner.query(
      `REVOKE INSERT, UPDATE ON "permissions", "permission_dependency", "role_permission" FROM app_runtime`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `GRANT INSERT, UPDATE ON "permissions", "permission_dependency", "role_permission" TO app_runtime`,
    );

    await queryRunner.query(`
      CREATE FUNCTION app_find_invitation(token_hash text)
      RETURNS TABLE (id uuid, organization_id uuid)
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
        SELECT i.id, i.organization_id FROM organization_invitations i
         WHERE i.token_hash = $1 AND i.deleted_at IS NULL
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_find_invitation(text) FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_find_invitation(text) TO app_runtime`,
    );
    await queryRunner.query(
      `DROP POLICY "invitation_by_token" ON "organization_invitations"`,
    );

    await queryRunner.query(`
      CREATE FUNCTION app_is_member(org uuid) RETURNS boolean
      LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
      AS $$
        SELECT EXISTS (
          SELECT 1 FROM user_organization uo
           WHERE uo.organization_id = $1
             AND uo.user_id = ${USER}
             AND uo.deleted_at IS NULL
        )
      $$
    `);
    await queryRunner.query(
      `REVOKE ALL ON FUNCTION app_is_member(uuid) FROM PUBLIC`,
    );
    await queryRunner.query(
      `GRANT EXECUTE ON FUNCTION app_is_member(uuid) TO app_runtime`,
    );
    await queryRunner.query(`DROP POLICY "org_update" ON "organizations"`);
    await queryRunner.query(
      `DROP POLICY "org_member_select" ON "organizations"`,
    );
    await queryRunner.query(
      `CREATE POLICY "org_member_select" ON "organizations" FOR SELECT USING (id = ${ORG} OR app_is_member(id))`,
    );
    await queryRunner.query(
      `CREATE POLICY "org_member_update" ON "organizations" FOR UPDATE USING (id = ${ORG} OR app_is_member(id)) WITH CHECK (id = ${ORG} OR app_is_member(id))`,
    );
  }
}
