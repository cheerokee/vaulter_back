import { DataSource, EntitySchema } from 'typeorm';
import type { Repository } from 'typeorm';
import { newId } from '../../src/shared/domain/id.js';
import { typeOrmOptions } from '../../src/database/typeorm.options.js';
import { enableOrganizationRls } from '../../src/shared/infra/db/migration-helpers.js';
import {
  OrganizationScopedRepository,
  runInOrganizationScope,
} from '../../src/shared/infra/db/organization-scope.js';
import { adminDataSource } from '../setup/test-app.js';

interface Probe {
  id: string;
  organizationId: string;
  v: string | null;
}

const ProbeSchema = new EntitySchema<Probe>({
  name: 'RlsProbe',
  tableName: 'rls_probe',
  columns: {
    id: { type: 'uuid', primary: true },
    organizationId: { type: 'uuid', name: 'organization_id' },
    v: { type: 'text', nullable: true },
  },
});

class ProbeRepository extends OrganizationScopedRepository<Probe> {
  constructor(ds: DataSource) {
    super(ds, ProbeSchema);
  }
  list(organizationId: string): Promise<Probe[]> {
    return this.scoped(organizationId, (repo: Repository<Probe>) =>
      repo.find({ where: { organizationId } }),
    );
  }
  add(organizationId: string, row: Probe): Promise<Probe> {
    return this.scoped(organizationId, (repo) => repo.save(row));
  }
}

describe('organization row-level security (e2e)', () => {
  let admin: DataSource;
  let app: DataSource;
  const orgA = newId();
  const orgB = newId();

  beforeAll(async () => {
    admin = await adminDataSource();
    await admin.query('DROP TABLE IF EXISTS rls_probe');
    await admin.query(
      'CREATE TABLE rls_probe (id uuid PRIMARY KEY, organization_id uuid NOT NULL, v text)',
    );
    const qr = admin.createQueryRunner();
    await enableOrganizationRls(qr, 'rls_probe');
    await qr.release();
    // O dono é superusuário e ignora RLS, então o seed entra direto.
    await admin.query(
      `INSERT INTO rls_probe (id, organization_id, v) VALUES ($1, $2, 'a1'), ($3, $2, 'a2'), ($4, $5, 'b1')`,
      [newId(), orgA, newId(), newId(), orgB],
    );
    app = new DataSource({
      ...typeOrmOptions('app'),
      entities: [ProbeSchema],
    });
    await app.initialize();
  });

  afterAll(async () => {
    await app.destroy();
    await admin.query('DROP TABLE IF EXISTS rls_probe');
  });

  it('returns only rows of the scoped organization', async () => {
    const rows = await runInOrganizationScope(app, orgA, (m) =>
      m.query('SELECT organization_id, v FROM rls_probe ORDER BY v'),
    );
    expect(rows).toEqual([
      { organization_id: orgA, v: 'a1' },
      { organization_id: orgA, v: 'a2' },
    ]);
  });

  it('returns nothing without an organization scope', async () => {
    expect(await app.query('SELECT * FROM rls_probe')).toEqual([]);
  });

  it('rejects writing a row for another organization', async () => {
    await expect(
      runInOrganizationScope(app, orgA, (m) =>
        m.query(
          `INSERT INTO rls_probe (id, organization_id, v) VALUES ($1, $2, 'x')`,
          [newId(), orgB],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('does not leak scope to the next transaction on the same connection', async () => {
    await runInOrganizationScope(app, orgA, (m) =>
      m.query('SELECT 1 FROM rls_probe'),
    );
    expect(await app.query('SELECT * FROM rls_probe')).toEqual([]);
  });

  it('lets the app role select, insert and update inside its scope', async () => {
    const id = newId();
    await runInOrganizationScope(app, orgA, async (m) => {
      await m.query(
        `INSERT INTO rls_probe (id, organization_id, v) VALUES ($1, $2, 'new')`,
        [id, orgA],
      );
      await m.query(`UPDATE rls_probe SET v = 'upd' WHERE id = $1`, [id]);
    });
    const rows = await runInOrganizationScope(app, orgA, (m) =>
      m.query('SELECT v FROM rls_probe WHERE id = $1', [id]),
    );
    expect(rows).toEqual([{ v: 'upd' }]);
  });

  it('cannot update rows of another organization (zero rows affected)', async () => {
    await runInOrganizationScope(app, orgA, (m) =>
      m.query(`UPDATE rls_probe SET v = 'hacked' WHERE organization_id = $1`, [
        orgB,
      ]),
    );
    const rows = await admin.query(
      `SELECT v FROM rls_probe WHERE organization_id = $1`,
      [orgB],
    );
    expect(rows).toEqual([{ v: 'b1' }]);
  });

  it('scopes queries made through OrganizationScopedRepository', async () => {
    const repo = new ProbeRepository(app);
    const listed = await repo.list(orgB);
    expect(listed.map((r) => r.v)).toEqual(['b1']);
    const saved = await repo.add(orgB, {
      id: newId(),
      organizationId: orgB,
      v: 'b2',
    });
    expect(saved.v).toBe('b2');
    await expect(
      repo.add(orgB, { id: newId(), organizationId: orgA, v: 'bad' }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
