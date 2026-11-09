import type { INestApplication } from '@nestjs/common';
import type request from 'supertest';
import { SpaceStorageUsage } from '../../src/spaces/application/space-storage-usage.js';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import { hubClient } from '../support/hub-client.js';
import type { ClaimedHub } from '../support/hubs-kit.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';

const GiB = 1024 ** 3;

function expectProblem(
  res: request.Response,
  status: number,
  type: string,
): Record<string, unknown> {
  if (res.status !== status) {
    throw new Error(
      `expected ${status} ${type}, got ${res.status}: ${JSON.stringify(res.body)}`,
    );
  }
  expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
  expect(res.body.type).toMatch(new RegExp(`/${type}$`));
  return res.body as Record<string, unknown>;
}

// Tamanho reservado do espaço, franquia da organização e capacidade do Hub (spec storage-backup §4.4, §4.5, §4.9),
// pela HTTP real e pelo papel de runtime (RLS valendo).
describe('storage quotas (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = hubClient(() => app);
  const as = (u: KeyedUser) => c.bearer(u.token);

  let olivia: KeyedUser; // dona dos Hubs e admin das organizações
  let ana: KeyedUser; // membro de uma das organizações

  const org = (name: string) => s.orgWithKit(olivia, name);
  const space = async (
    orgId: string,
    kit: string,
    name: string,
    storageQuotaBytes?: number,
  ) => {
    const sp = await s.create(
      olivia,
      orgId,
      kit,
      name,
      storageQuotaBytes !== undefined ? { storageQuotaBytes } : {},
    );
    await expectStatus(Promise.resolve(sp.res), 201);
    return sp;
  };
  const link = (hubId: string, organizationId: string) =>
    expectStatus(
      c
        .http()
        .post(`/hubs/${hubId}/organizations`)
        .set(as(olivia))
        .send({ organizationId }),
      201,
    );
  const install = (hubId: string, spaceId: string, who = olivia) =>
    c.http().post(`/hubs/${hubId}/spaces`).set(as(who)).send({ spaceId });
  const reportCapacity = async (hub: ClaimedHub, capacityBytes: number) => {
    // Token first: a supertest request created before another one finishes loses its server address.
    const token = await h.authenticate(hub);
    return c
      .http()
      .put('/hub/storage')
      .set(h.bearer(token))
      .send({ capacityBytes });
  };
  const resize = (spaceId: string, storageQuotaBytes: number, who = olivia) =>
    c
      .http()
      .put(`/spaces/${spaceId}/storage-quota`)
      .set(as(who))
      .send({ storageQuotaBytes });

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
    olivia = await s.signUpKeyed('olivia@example.com', 'Olivia');
    ana = await s.signUpKeyed('ana@example.com', 'Ana');
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  afterEach(() => {
    app.get(SpaceStorageUsage).release();
  });

  describe('organization quota', () => {
    it('creating beyond the quota is 422 with what is still available; the views show the numbers', async () => {
      const o = await org('Quota');
      const big = await space(o.orgId, o.kit.publicKey, 'Grande', 45 * GiB);
      expect(big.res.body.storage).toEqual({
        quotaBytes: 45 * GiB,
        usedBytes: 0,
      });
      const refused = await s.create(olivia, o.orgId, o.kit.publicKey, 'Mais');
      expect(
        expectProblem(refused.res, 422, 'organization-storage-quota-exceeded'),
      ).toMatchObject({ availableBytes: 5 * GiB });
      await space(o.orgId, o.kit.publicKey, 'Resto', 5 * GiB);

      const orgView = await expectStatus(
        c.http().get(`/organizations/${o.orgId}`).set(as(olivia)),
        200,
      );
      expect(orgView.body.storage).toEqual({
        quotaBytes: 50 * GiB,
        reservedBytes: 50 * GiB,
      });
      const spaceView = await expectStatus(
        c.http().get(`/spaces/${big.spaceId}`).set(as(olivia)),
        200,
      );
      expect(spaceView.body.storage).toEqual({
        quotaBytes: 45 * GiB,
        usedBytes: 0,
      });
    });

    it('a default space is 10 GiB; the size is validated (1 GiB .. 5 TiB)', async () => {
      const o = await org('Default');
      const sp = await space(o.orgId, o.kit.publicKey, 'Padrão');
      expect(sp.res.body.storage.quotaBytes).toBe(10_737_418_240);
      for (const bad of [GiB - 1, 5 * 1024 ** 4 + 1, 1.5, '10']) {
        const res = await s.create(olivia, o.orgId, o.kit.publicKey, 'X', {
          storageQuotaBytes: bad,
        });
        expectProblem(res.res, 422, 'validation-failed');
      }
    });

    it('growing beyond the quota is 422; shrinking below the usage is 422; only the manager resizes', async () => {
      const o = await org('Resize');
      await s.joinOrg(olivia, o.orgId, ana);
      const sp = await space(o.orgId, o.kit.publicKey, 'Docs', 40 * GiB);
      await expectStatus(
        s.addMember(
          olivia.token,
          sp.spaceId,
          recipientOf(ana),
          [sp.key],
          'space_editor',
        ),
        201,
      );
      expect(
        expectProblem(
          await resize(sp.spaceId, 50 * GiB + 1),
          422,
          'organization-storage-quota-exceeded',
        ),
      ).toMatchObject({ availableBytes: 10 * GiB });
      const grown = await expectStatus(resize(sp.spaceId, 50 * GiB), 200);
      expect(grown.body.storage).toEqual({
        quotaBytes: 50 * GiB,
        usedBytes: 0,
      });

      expectProblem(
        await resize(sp.spaceId, 20 * GiB, ana),
        403,
        'permission-denied',
      );

      app.get(SpaceStorageUsage).use({ usedBytes: async () => 3 * GiB });
      expect(
        expectProblem(
          await resize(sp.spaceId, 2 * GiB),
          422,
          'space-storage-quota-below-usage',
        ),
      ).toMatchObject({ usedBytes: 3 * GiB });
      const shrunk = await expectStatus(resize(sp.spaceId, 3 * GiB), 200);
      expect(shrunk.body.storage).toEqual({
        quotaBytes: 3 * GiB,
        usedBytes: 3 * GiB,
      });
    });
  });

  describe('hub capacity', () => {
    it('a hub without capacity installs anything; the view shows null capacity and the reserved sum', async () => {
      const o = await org('NoCap');
      const hub = await h.onboard(olivia.token, 'SemCapacidade');
      await link(hub.hubId, o.orgId);
      const a = await space(o.orgId, o.kit.publicKey, 'A', 40 * GiB);
      const b = await space(o.orgId, o.kit.publicKey, 'B', 10 * GiB);
      await expectStatus(install(hub.hubId, a.spaceId), 201);
      await expectStatus(install(hub.hubId, b.spaceId), 201);
      const view = await expectStatus(
        c.http().get(`/hubs/${hub.hubId}`).set(as(olivia)),
        200,
      );
      expect(view.body.storage).toEqual({
        capacityBytes: null,
        reservedBytes: 50 * GiB,
      });
    });

    it('installing without room is 422 with what is missing; reinstalling the same space is not counted twice', async () => {
      const o = await org('Cap');
      const hub = await h.onboard(olivia.token, 'Pequeno');
      await link(hub.hubId, o.orgId);
      await expectStatus(reportCapacity(hub, 15 * GiB), 204);
      const a = await space(o.orgId, o.kit.publicKey, 'A');
      const b = await space(o.orgId, o.kit.publicKey, 'B');
      await expectStatus(install(hub.hubId, a.spaceId), 201);
      await expectStatus(install(hub.hubId, a.spaceId), 201);
      expect(
        expectProblem(
          await install(hub.hubId, b.spaceId),
          422,
          'hub-storage-full',
        ),
      ).toMatchObject({ missingBytes: 5 * GiB });
      const view = await expectStatus(
        c.http().get(`/hubs/${hub.hubId}`).set(as(olivia)),
        200,
      );
      expect(view.body.storage).toEqual({
        capacityBytes: 15 * GiB,
        reservedBytes: 10 * GiB,
      });
    });

    it('the capacity counts spaces of every organization on the hub', async () => {
      const o1 = await org('Cross1');
      const o2 = await org('Cross2');
      const hub = await h.onboard(olivia.token, 'Compartilhado');
      await link(hub.hubId, o1.orgId);
      await link(hub.hubId, o2.orgId);
      await expectStatus(reportCapacity(hub, 25 * GiB), 204);
      const a = await space(o1.orgId, o1.kit.publicKey, 'A', 20 * GiB);
      const b = await space(o2.orgId, o2.kit.publicKey, 'B', 6 * GiB);
      await expectStatus(install(hub.hubId, a.spaceId), 201);
      expect(
        expectProblem(
          await install(hub.hubId, b.spaceId),
          422,
          'hub-storage-full',
        ),
      ).toMatchObject({ missingBytes: GiB });
    });

    it('a hub reporting less than what is reserved is accepted (204); the next install is 422', async () => {
      const o = await org('Shrink');
      const hub = await h.onboard(olivia.token, 'SSDTrocado');
      await link(hub.hubId, o.orgId);
      const a = await space(o.orgId, o.kit.publicKey, 'A', 20 * GiB);
      const b = await space(o.orgId, o.kit.publicKey, 'B', GiB);
      await expectStatus(install(hub.hubId, a.spaceId), 201);
      await expectStatus(reportCapacity(hub, 10 * GiB), 204);
      expect(
        expectProblem(
          await install(hub.hubId, b.spaceId),
          422,
          'hub-storage-full',
        ),
      ).toMatchObject({ missingBytes: 11 * GiB });
      const view = await expectStatus(
        c.http().get(`/hubs/${hub.hubId}`).set(as(olivia)),
        200,
      );
      expect(view.body.storage).toEqual({
        capacityBytes: 10 * GiB,
        reservedBytes: 20 * GiB,
      });
    });

    it('growing a space beyond a hub where it is installed is 422 with the hub and what is missing', async () => {
      const o = await org('GrowHub');
      const hub = await h.onboard(olivia.token, 'Limite');
      await link(hub.hubId, o.orgId);
      await expectStatus(reportCapacity(hub, 20 * GiB), 204);
      const a = await space(o.orgId, o.kit.publicKey, 'A');
      await expectStatus(install(hub.hubId, a.spaceId), 201);
      expect(
        expectProblem(
          await resize(a.spaceId, 25 * GiB),
          422,
          'hub-storage-full',
        ),
      ).toEqual(
        expect.objectContaining({ hubId: hub.hubId, missingBytes: 5 * GiB }),
      );
      await expectStatus(resize(a.spaceId, 20 * GiB), 200);
      const view = await expectStatus(
        c.http().get(`/hubs/${hub.hubId}`).set(as(olivia)),
        200,
      );
      expect(view.body.storage.reservedBytes).toBe(20 * GiB);
    });

    it('concurrent installs on the same hub never exceed its capacity', async () => {
      const o = await org('Race');
      const hub = await h.onboard(olivia.token, 'Corrida');
      await link(hub.hubId, o.orgId);
      await expectStatus(reportCapacity(hub, 15 * GiB), 204);
      const a = await space(o.orgId, o.kit.publicKey, 'A');
      const b = await space(o.orgId, o.kit.publicKey, 'B');
      const results = await Promise.all([
        install(hub.hubId, a.spaceId),
        install(hub.hubId, b.spaceId),
      ]);
      expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([
        201, 422,
      ]);
    });

    it('a member who is not the owner sees only the reserved space of their organizations', async () => {
      const shared = await org('Visivel');
      const hidden = await org('Oculta');
      await s.joinOrg(olivia, shared.orgId, ana);
      const hub = await h.onboard(olivia.token, 'Visao');
      await link(hub.hubId, shared.orgId);
      await link(hub.hubId, hidden.orgId);
      const a = await space(shared.orgId, shared.kit.publicKey, 'A', 3 * GiB);
      const b = await space(hidden.orgId, hidden.kit.publicKey, 'B', 4 * GiB);
      await expectStatus(install(hub.hubId, a.spaceId), 201);
      await expectStatus(install(hub.hubId, b.spaceId), 201);
      const asAna = await expectStatus(
        c.http().get(`/hubs/${hub.hubId}`).set(as(ana)),
        200,
      );
      expect(asAna.body.storage).toEqual({
        capacityBytes: null,
        reservedBytes: 3 * GiB,
      });
      const asOwner = await expectStatus(
        c.http().get(`/hubs/${hub.hubId}`).set(as(olivia)),
        200,
      );
      expect(asOwner.body.storage.reservedBytes).toBe(7 * GiB);
    });

    it('PUT /hub/storage takes only a hub token and validates the capacity (1 GiB .. 64 TiB)', async () => {
      const hub = await h.onboard(olivia.token, 'Validacao');
      const token = await h.authenticate(hub);
      for (const bad of [GiB - 1, 64 * 1024 ** 4 + 1, 2.5, '10', undefined]) {
        const res = await c
          .http()
          .put('/hub/storage')
          .set(h.bearer(token))
          .send({ capacityBytes: bad });
        expectProblem(res, 422, 'validation-failed');
      }
      await expectStatus(
        c
          .http()
          .put('/hub/storage')
          .set(as(olivia))
          .send({ capacityBytes: GiB }),
        401,
      );
      await expectStatus(
        c
          .http()
          .put('/hub/storage')
          .set(h.bearer(token))
          .send({ capacityBytes: 64 * 1024 ** 4 }),
        204,
      );
    });
  });
});
