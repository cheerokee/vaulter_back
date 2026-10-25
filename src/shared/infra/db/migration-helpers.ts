import type { QueryRunner } from 'typeorm';

// Adiciona sync_version (bigint NOT NULL), índice e trigger à tabela. Linhas já existentes recebem
// valores da sequência global antes de a coluna virar NOT NULL.
export async function addSyncVersionTrigger(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`ALTER TABLE "${table}" ADD COLUMN "sync_version" bigint`);
  await qr.query(
    `UPDATE "${table}" SET "sync_version" = nextval('sync_version_seq')`,
  );
  await qr.query(
    `ALTER TABLE "${table}" ALTER COLUMN "sync_version" SET NOT NULL`,
  );
  await qr.query(
    `CREATE INDEX "ix_${table}_sync_version" ON "${table}" ("sync_version")`,
  );
  await qr.query(
    `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
      `FOR EACH ROW EXECUTE FUNCTION set_sync_version()`,
  );
}

export async function dropSyncVersionTrigger(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(
    `DROP TRIGGER IF EXISTS "trg_${table}_sync_version" ON "${table}"`,
  );
  await qr.query(`DROP INDEX IF EXISTS "ix_${table}_sync_version"`);
  await qr.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "sync_version"`);
}

const ORG_SETTING = `NULLIF(current_setting('app.organization_id', true), '')::uuid`;

// Isolamento por organização: sem `app.organization_id` na transação, nenhuma linha é visível nem gravável.
// FORCE vale também para o dono da tabela (exceto superusuário, que sempre ignora RLS).
export async function enableOrganizationRls(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`);
  await qr.query(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`);
  await qr.query(
    `CREATE POLICY "org_isolation" ON "${table}" ` +
      `USING (organization_id = ${ORG_SETTING}) WITH CHECK (organization_id = ${ORG_SETTING})`,
  );
}

export async function disableOrganizationRls(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`DROP POLICY IF EXISTS "org_isolation" ON "${table}"`);
  await qr.query(`ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY`);
  await qr.query(`ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY`);
}
