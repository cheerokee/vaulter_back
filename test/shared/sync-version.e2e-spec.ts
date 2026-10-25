import type { DataSource } from 'typeorm';
import { addSyncVersionTrigger } from '../../src/shared/infra/db/migration-helpers.js';
import { adminDataSource } from '../setup/test-app.js';
import { newId } from '../../src/shared/domain/id.js';
import { typeOrmOptions } from '../../src/database/typeorm.options.js';
import { DataSource as DS } from 'typeorm';

describe('sync_version infrastructure', () => {
  let admin: DataSource;
  let app: DataSource;

  const syncOf = async (
    ds: DataSource,
    table: string,
    id: string,
  ): Promise<bigint> => {
    const rows: { sync_version: string }[] = await ds.query(
      `SELECT sync_version FROM ${table} WHERE id = $1`,
      [id],
    );
    return BigInt(rows[0].sync_version);
  };

  beforeAll(async () => {
    admin = await adminDataSource();
    app = new DS(typeOrmOptions('app'));
    await app.initialize();
    for (const t of ['sync_probe', 'sync_probe_b']) {
      await admin.query(`DROP TABLE IF EXISTS ${t}`);
      await admin.query(
        `CREATE TABLE ${t} (id uuid PRIMARY KEY, v text, deleted_at timestamptz)`,
      );
      const qr = admin.createQueryRunner();
      await addSyncVersionTrigger(qr, t);
      await qr.release();
    }
  });

  afterAll(async () => {
    await admin.query(`DROP TABLE IF EXISTS sync_probe, sync_probe_b`);
    await app.destroy();
    await admin.destroy();
  });

  it('assigns sync_version on insert and bumps it on every update, including soft delete', async () => {
    const id = newId();
    // Como app_runtime (não dono): prova que nextval via trigger funciona com os grants padrão.
    await app.query(`INSERT INTO sync_probe (id, v) VALUES ($1, 'a')`, [id]);
    const v1 = await syncOf(app, 'sync_probe', id);
    await app.query(`UPDATE sync_probe SET v = 'b' WHERE id = $1`, [id]);
    const v2 = await syncOf(app, 'sync_probe', id);
    await app.query(`UPDATE sync_probe SET deleted_at = now() WHERE id = $1`, [
      id,
    ]);
    const v3 = await syncOf(app, 'sync_probe', id);
    expect(v2 > v1).toBe(true);
    expect(v3 > v2).toBe(true);
  });

  it('uses one global sequence across tables', async () => {
    const a = newId();
    const b = newId();
    await admin.query(`INSERT INTO sync_probe (id) VALUES ($1)`, [a]);
    await admin.query(`INSERT INTO sync_probe_b (id) VALUES ($1)`, [b]);
    await admin.query(`UPDATE sync_probe SET v = 'x' WHERE id = $1`, [a]);
    const x1 = await syncOf(admin, 'sync_probe', a);
    await admin.query(`UPDATE sync_probe_b SET v = 'y' WHERE id = $1`, [b]);
    const y1 = await syncOf(admin, 'sync_probe_b', b);
    await admin.query(`UPDATE sync_probe SET v = 'z' WHERE id = $1`, [a]);
    const x2 = await syncOf(admin, 'sync_probe', a);
    expect(x1 < y1).toBe(true);
    expect(y1 < x2).toBe(true);
  });
});
