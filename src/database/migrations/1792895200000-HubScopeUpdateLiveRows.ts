import { MigrationInterface, QueryRunner } from 'typeorm';

const USER = `NULLIF(current_setting('app.user_id', true), '')::uuid`;
const HUB = `NULLIF(current_setting('app.hub_id', true), '')::uuid`;

const HUB_OWNER = `scope_type = 'hub' AND EXISTS (
     SELECT 1 FROM hubs h WHERE h.id = role_assignments.hub_id AND h.owner_user_id = ${USER})`;
const THE_HUB_ASSIGNABLE = `scope_type = 'hub' AND hub_id = ${HUB} AND role_id IN (
     SELECT r.id FROM roles r
      WHERE r.organization_id IS NULL AND r.scope_type = 'hub' AND r.key IN ('hub_operator', 'hub_user'))`;

// O ramo do Hub em hub_scope_update (HardenHubsRls) só alcança linhas vivas (`deleted_at IS NULL` no USING): o Hub
// grava a lápide uma vez e não mexe mais em lápides (nem no user_id ou no papel delas). O ramo da dona não muda.
export class HubScopeUpdateLiveRows1792895200000 implements MigrationInterface {
  name = 'HubScopeUpdateLiveRows1792895200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY "hub_scope_update" ON "role_assignments"`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_scope_update" ON "role_assignments" FOR UPDATE
         USING ((${HUB_OWNER}) OR ((${THE_HUB_ASSIGNABLE}) AND deleted_at IS NULL))
         WITH CHECK ((${HUB_OWNER}) OR ((${THE_HUB_ASSIGNABLE}) AND deleted_at IS NOT NULL))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP POLICY "hub_scope_update" ON "role_assignments"`,
    );
    await queryRunner.query(
      `CREATE POLICY "hub_scope_update" ON "role_assignments" FOR UPDATE
         USING ((${HUB_OWNER}) OR (${THE_HUB_ASSIGNABLE}))
         WITH CHECK ((${HUB_OWNER}) OR ((${THE_HUB_ASSIGNABLE}) AND deleted_at IS NOT NULL))`,
    );
  }
}
