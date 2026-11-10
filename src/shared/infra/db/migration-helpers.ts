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

// Versões de feed na ordem dos xids (horizonte seguro; feeds dos assuntos). Com a sequência global, a versão sai na
// ESCRITA, não no COMMIT: uma transação com versão menor pode confirmar depois de outra com versão maior, e um cursor
// `nextSince` que passou da maior pula a menor para sempre (Pendências do CLAUDE.md). Nestas tabelas a versão passa a
// ser `xid8 da transação que grava << 16 | n`, com `n` o contador de linhas gravadas por ela (`app.sync_row`, local à
// transação; satura em 65535: linhas além disso empatam, e a fusão dos feeds nunca parte um empate). Consequência:
// - toda versão de uma transação com xid < `pg_snapshot_xmin(snapshot)` é final (a transação terminou) e toda escrita
//   futura (transação em andamento ou que ainda vai começar) tem xid >= xmin, logo versão >= `xmin << 16`. Quem lê só
//   entrega versões abaixo desse limite, e o cursor nunca passa por cima de uma versão que ainda pode confirmar;
// - o xid da transação que gravou fica na própria versão (`sync_version >> 16`); a ordem entre transações é a dos xids
//   (atribuídos no primeiro write/lock), e dentro de uma transação a ordem das gravações;
// - as versões continuam crescendo para cada linha que um cliente já recebeu: uma transação mais antiga que grava a
//   mesma linha depois de uma mais nova só é servida depois de terminar (o limite fica abaixo das duas);
// - cabe no JSON (2^53) até xid8 = 2^37 (~137 bilhões de transações no cluster). As versões antigas (sequência global,
//   bem menores) continuam valendo como cursor.
export async function useXidSyncVersion(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`DROP TRIGGER "trg_${table}_sync_version" ON "${table}"`);
  await qr.query(
    `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
      `FOR EACH ROW EXECUTE FUNCTION set_xid_sync_version()`,
  );
}

export async function useSequenceSyncVersion(
  qr: QueryRunner,
  table: string,
): Promise<void> {
  await qr.query(`DROP TRIGGER "trg_${table}_sync_version" ON "${table}"`);
  await qr.query(
    `CREATE TRIGGER "trg_${table}_sync_version" BEFORE INSERT OR UPDATE ON "${table}" ` +
      `FOR EACH ROW EXECUTE FUNCTION set_sync_version()`,
  );
}

/** Bits of the per-transaction row counter in a xid-ordered `sync_version` (`useXidSyncVersion`). */
export const XID_SYNC_VERSION_SHIFT = 16;
