import type { INestApplication } from '@nestjs/common';
import type { DataSource, QueryRunner } from 'typeorm';
import { HubTokenService } from '../../src/identity/application/hub-token-service.js';
import { HUB_SYNC_TABLES } from '../setup/commit-order-check.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import { conversationsKit } from '../support/conversations-kit.js';
import { type ClaimedHub, hubsKit } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from '../support/identity-client.js';

type Item = {
  type: string;
  syncVersion: number;
  deleted: boolean;
  data: Record<string, unknown>;
};
type Page = { items: Item[]; nextSince: number };

const PASSWORD = 'correct horse battery staple';

// Versões do GET /hub/sync dadas no COMMIT, na ordem dos commits (migration HubSyncCommitOrder): um commit atrasado
// nunca é pulado pelo `nextSince`, transações que gravam nos dois feeds nunca dão deadlock, e as gravações em contextos
// especiais (o do Hub, as cascatas) saem do COMMIT com versão.
describe('hub sync: versions in commit order (e2e)', () => {
  let app: INestApplication;
  let admin: DataSource;
  const c = identityClient(() => app);
  const s = c.spaces;
  const k = hubsKit(() => app);
  const conv = conversationsKit(() => app);

  let olivia: KeyedUser;
  let hub: ClaimedHub;
  let orgId: string;
  let spaceA: string;
  let spaceB: string;

  const hubToken = async (h: ClaimedHub) =>
    (await app.get(HubTokenService).issue(h.hubId)).token;
  const sync = async (h: ClaimedHub, since: number): Promise<Page> =>
    (
      await expectStatus(
        c
          .http()
          .get('/hub/sync')
          .query({ since, limit: 500 })
          .set({ Authorization: `Bearer ${await hubToken(h)}` }),
        200,
      )
    ).body as Page;
  /** Every page from `since` until an empty one: the items and the cursor the hub would keep. */
  const drain = async (h: ClaimedHub, since: number) => {
    const items: Item[] = [];
    for (let i = 0; i < 100; i++) {
      const page = await sync(h, since);
      if (page.items.length === 0) return { items, since };
      items.push(...page.items);
      since = page.nextSince;
    }
    throw new Error('sync did not converge');
  };
  const spaceItem = (items: Item[], id: string) =>
    items.find((i) => i.type === 'space' && i.data.id === id);
  const pendingRows = async () => {
    const counts: Record<string, number> = {};
    for (const table of Object.keys(HUB_SYNC_TABLES)) {
      const [{ n }] = (await admin.query(
        `SELECT count(*)::int AS n FROM "${table}" WHERE sync_pending`,
      )) as [{ n: number }];
      if (n > 0) counts[table] = n;
    }
    return counts;
  };
  const openTx = async () => {
    const qr = admin.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    return qr;
  };
  const close = async (qr: QueryRunner) => {
    if (qr.isTransactionActive) await qr.rollbackTransaction();
    await qr.release();
  };

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    admin = await adminDataSource();
    olivia = await s.signUpKeyed('co-olivia@example.com', 'Olivia', PASSWORD);
    hub = await k.claim(olivia, 'Sala');
    const org = await s.orgWithKit(olivia, 'Org A');
    orgId = org.orgId;
    await k.link(olivia, hub.hubId, orgId);
    const a = await s.create(olivia, orgId, org.kit.publicKey, 'A');
    const b = await s.create(olivia, orgId, org.kit.publicKey, 'B');
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    spaceA = a.spaceId;
    spaceB = b.spaceId;
    await k.addSpace(olivia, hub.hubId, spaceA);
    await k.addSpace(olivia, hub.hubId, spaceB);
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('inverted commit order: the later commit is served at once, the earlier one comes after it with a higher version; nextSince never skips', async () => {
    const { since: start } = await drain(hub, 0);
    const t1 = await openTx();
    const t2 = await openTx();
    try {
      // A: written first, committed last.
      await t1.query(`UPDATE spaces SET name = 'A2' WHERE id = $1`, [spaceA]);
      await t2.query(`UPDATE spaces SET name = 'B2' WHERE id = $1`, [spaceB]);
      await t2.commitTransaction();

      const early = await drain(hub, start);
      const b = spaceItem(early.items, spaceB);
      expect(b?.data.name).toBe('B2');
      expect(spaceItem(early.items, spaceA)).toBeUndefined();

      await t1.commitTransaction();
      const late = await drain(hub, early.since);
      const a = spaceItem(late.items, spaceA);
      expect(a?.data.name).toBe('A2');
      expect(a!.syncVersion).toBeGreaterThan(b!.syncVersion);
    } finally {
      await close(t1);
      await close(t2);
    }
  });

  it('a transaction writing both feeds in opposite orders never deadlocks', async () => {
    const created = await conv.create(olivia, spaceA);
    await expectStatus(Promise.resolve(created.res), 201);
    const t1 = await openTx();
    const t2 = await openTx();
    try {
      // T1: conversation, then space A; T2: space B, then the conversation feed through another row (the owner's key
      // copy), so neither waits on a row lock of the other and both reach COMMIT together.
      await t1.query(
        `UPDATE conversations SET updated_at = now() WHERE id = $1`,
        [created.id],
      );
      await t1.query(`UPDATE spaces SET updated_at = now() WHERE id = $1`, [
        spaceA,
      ]);
      await t2.query(`UPDATE spaces SET updated_at = now() WHERE id = $1`, [
        spaceB,
      ]);
      await t2.query(
        `UPDATE conversation_key_grants SET updated_at = now() WHERE conversation_id = $1`,
        [created.id],
      );
      // Deferred triggers fire in write order: T1 would take the conversation lock first, T2 the space one.
      await Promise.all([t1.commitTransaction(), t2.commitTransaction()]);
    } finally {
      await close(t1);
      await close(t2);
    }
    const [{ n }] = (await admin.query(
      `SELECT count(*)::int AS n FROM conversations WHERE id = $1 AND NOT sync_pending`,
      [created.id],
    )) as [{ n: number }];
    expect(n).toBe(1);
    expect(await pendingRows()).toEqual({});
  });

  it('a hub-context write (PUT /hub/storage) commits and the hub item comes back with a newer version', async () => {
    const { since } = await drain(hub, 0);
    await expectStatus(
      c
        .http()
        .put('/hub/storage')
        .set({ Authorization: `Bearer ${await hubToken(hub)}` })
        .send({ capacityBytes: 2 ** 40 }),
      204,
    );
    const { items } = await drain(hub, since);
    const item = items.find((i) => i.type === 'hub');
    expect(item).toBeDefined();
    expect(item!.syncVersion).toBeGreaterThan(since);
    expect(await pendingRows()).toEqual({});
  });

  it('an old cursor keeps working: an incremental pass returns only what changed after it', async () => {
    const { since } = await drain(hub, 0);
    await admin.query(`UPDATE spaces SET name = 'A3' WHERE id = $1`, [spaceA]);
    const { items } = await drain(hub, since);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.syncVersion > since)).toBe(true);
    expect(spaceItem(items, spaceA)?.data.name).toBe('A3');
  });

  it('cascades written in contexts that no longer see the rows commit with versions: the owner leaving a linked organization, deregistering', async () => {
    const carl = await s.signUpKeyed('co-carl@example.com', 'Carl', PASSWORD);
    const other = await k.claim(olivia, 'Cozinha');
    const orgC = await s.orgWithKit(carl, 'Org C');
    await s.joinOrg(carl, orgC.orgId, olivia);
    await k.link(olivia, other.hubId, orgC.orgId);
    // The hub owner leaves: her hub is unlinked from the organization she no longer sees.
    await expectStatus(
      c
        .http()
        .post(`/organizations/${orgC.orgId}/leave`)
        .set(c.bearer(olivia.token)),
      204,
    );
    expect(await pendingRows()).toEqual({});
    await k.deregister(olivia, hub.hubId);
    expect(await pendingRows()).toEqual({});
    const links = (await admin.query(
      `SELECT count(*)::int AS n FROM hub_organization WHERE hub_id = ANY($1) AND deleted_at IS NOT NULL`,
      [[hub.hubId, other.hubId]],
    )) as [{ n: number }];
    expect(links[0].n).toBeGreaterThan(0);
  });
});
