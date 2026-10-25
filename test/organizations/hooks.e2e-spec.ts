import type { INestApplication } from '@nestjs/common';
import { InvitationHooks } from '../../src/shared/application/invitation-hooks.js';
import { MemberRemovedHooks } from '../../src/shared/application/member-removed-hooks.js';
import { SpacesInvitationHook } from '../../src/spaces/application/invitation.hook.js';
import {
  adminDataSource,
  createTestApp,
  resetDatabase,
} from '../setup/test-app.js';
import {
  type ClientAccount,
  createClientAccount,
} from '../support/client-crypto.js';
import { identityClient } from '../support/identity-client.js';

const PASSWORD = 'correct horse battery staple';
const SPACE = '019a1b2c-0000-7000-8000-0000000000f1';

describe('Organization hooks (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const c = identityClient(() => app);
  const count = async (sql: string, params: unknown[]) =>
    Number(
      (
        (await (await adminDataSource()).query(sql, params)) as { n: string }[]
      )[0]!.n,
    );

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('a throwing member-removed hook fails the removal with a generic 500 and changes nothing', async () => {
    const owner = await c.signUp(account, 'hk-owner@example.com', 'Olivia');
    const guest = await c.signUp(account, 'hk-guest@example.com', 'Guest');
    const org = (await c.createOrg(owner.token, 'Hook Inc').expect(201)).body
      .id as string;
    const inv = await c.invite(owner.token, org, 'org_member').expect(201);
    await c.acceptInvite(guest.token, inv.body.token).expect(200);

    const hooks = app.get(MemberRemovedHooks);
    hooks.register({
      name: 'e2e-throwing',
      onMemberRemoved: () => Promise.reject(new Error('hook exploded')),
    });
    try {
      const res = await c
        .http()
        .delete(`/organizations/${org}/members/${guest.userId}`)
        .set(c.bearer(owner.token));
      expect(res.status).toBe(500);
      expect(JSON.stringify(res.body)).not.toContain('hook exploded');
      const active = await count(
        `SELECT count(*) AS n FROM user_organization WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [org, guest.userId],
      );
      expect(active).toBe(1);
    } finally {
      hooks.unregister('e2e-throwing');
    }
    await c
      .http()
      .delete(`/organizations/${org}/members/${guest.userId}`)
      .set(c.bearer(owner.token))
      .expect(204);
  });

  // O `spaces` assina o registro no boot; estes testes o tiram por um momento para isolar o comportamento do
  // registro (e o devolvem no fim).
  const withoutSpacesHook = async (work: () => Promise<void>) => {
    const spacesHook = app.get(SpacesInvitationHook);
    spacesHook.onModuleDestroy();
    try {
      await work();
    } finally {
      spacesHook.onModuleInit();
    }
  };

  it('invitation with spaces and no subscriber -> 422 spaces-not-supported, no row', async () => {
    const owner = await c.signUp(account, 'hk-nosub@example.com', 'Olivia');
    const org = (await c.createOrg(owner.token, 'NoSub Inc').expect(201)).body
      .id as string;
    await withoutSpacesHook(async () => {
      const res = await c
        .http()
        .post(`/organizations/${org}/invitations`)
        .set(c.bearer(owner.token))
        .send({
          roleKey: 'org_member',
          spaces: [{ spaceId: SPACE, roleKey: 'space_reader' }],
        });
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toContain('spaces-not-supported');
    });
    expect(
      await count(
        `SELECT count(*) AS n FROM organization_invitations WHERE organization_id = $1`,
        [org],
      ),
    ).toBe(0);
  });

  it('with the spaces subscriber, an unknown space -> 404 space-not-found, no row', async () => {
    const owner = await c.signUp(account, 'hk-unknown@example.com', 'Olivia');
    const org = (await c.createOrg(owner.token, 'Unknown Inc').expect(201)).body
      .id as string;
    const res = await c
      .http()
      .post(`/organizations/${org}/invitations`)
      .set(c.bearer(owner.token))
      .send({
        roleKey: 'org_member',
        spaces: [{ spaceId: SPACE, roleKey: 'space_reader' }],
      });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).toContain('space-not-found');
    expect(
      await count(
        `SELECT count(*) AS n FROM organization_invitations WHERE organization_id = $1`,
        [org],
      ),
    ).toBe(0);
  });

  it('a throwing validateAndRecord fails the creation with a generic 500 and no invitation row', async () => {
    const owner = await c.signUp(account, 'hk-inv@example.com', 'Olivia');
    const org = (await c.createOrg(owner.token, 'Inv Hook Inc').expect(201))
      .body.id as string;
    const hooks = app.get(InvitationHooks);
    hooks.register({
      name: 'e2e-throwing',
      validateAndRecord: () => Promise.reject(new Error('hook exploded')),
      onAccepted: () => Promise.resolve(),
    });
    try {
      await withoutSpacesHook(async () => {
        const res = await c
          .http()
          .post(`/organizations/${org}/invitations`)
          .set(c.bearer(owner.token))
          .send({
            roleKey: 'org_member',
            spaces: [{ spaceId: SPACE, roleKey: 'space_editor' }],
          });
        expect(res.status).toBe(500);
      });
      expect(
        await count(
          `SELECT count(*) AS n FROM organization_invitations WHERE organization_id = $1`,
          [org],
        ),
      ).toBe(0);
    } finally {
      hooks.unregister('e2e-throwing');
    }
  });

  it('a throwing onAccepted (non-domain error) fails the acceptance with a generic 500: no membership, invitation still pending', async () => {
    const owner = await c.signUp(account, 'hk-acc-owner@example.com', 'Olivia');
    const guest = await c.signUp(account, 'hk-acc-guest@example.com', 'Guest');
    const org = (await c.createOrg(owner.token, 'Accept Hook Inc').expect(201))
      .body.id as string;
    const inv = await c.invite(owner.token, org, 'org_member').expect(201);
    const invitationId = inv.body.invitation.id as string;
    const hooks = app.get(InvitationHooks);
    hooks.register({
      name: 'e2e-throwing-accept',
      validateAndRecord: () => Promise.resolve(),
      onAccepted: () => Promise.reject(new Error('accept hook exploded')),
    });
    try {
      const res = await c.acceptInvite(guest.token, inv.body.token);
      expect(res.status).toBe(500);
      expect(res.body.type).toMatch(/\/internal-error$/);
      expect(JSON.stringify(res.body)).not.toContain('accept hook exploded');
      expect(
        await count(
          `SELECT count(*) AS n FROM user_organization WHERE organization_id = $1 AND user_id = $2`,
          [org, guest.userId],
        ),
      ).toBe(0);
      expect(
        await count(
          `SELECT count(*) AS n FROM organization_invitations WHERE id = $1 AND status = 'pending' AND accepted_by_user_id IS NULL`,
          [invitationId],
        ),
      ).toBe(1);
      expect(
        await count(
          `SELECT count(*) AS n FROM audit_logs WHERE organization_id = $1 AND action = 'member.joined' AND user_id = $2`,
          [org, guest.userId],
        ),
      ).toBe(0);
    } finally {
      hooks.unregister('e2e-throwing-accept');
    }
    // the invitation was not burned: it still works once the hook is gone
    await c.acceptInvite(guest.token, inv.body.token).expect(200);
  });

  it('DTO: duplicate spaceId and more than 20 spaces -> 422', async () => {
    const owner = await c.signUp(account, 'hk-dto@example.com', 'Olivia');
    const org = (await c.createOrg(owner.token, 'Dto Inc').expect(201)).body
      .id as string;
    const post = (spaces: unknown) =>
      c
        .http()
        .post(`/organizations/${org}/invitations`)
        .set(c.bearer(owner.token))
        .send({ roleKey: 'org_member', spaces });
    await post([
      { spaceId: SPACE, roleKey: 'space_reader' },
      { spaceId: SPACE, roleKey: 'space_editor' },
    ]).expect(422);
    await post(
      Array.from({ length: 21 }, (_, i) => ({
        spaceId: `019a1b2c-0000-7000-8000-${String(i).padStart(12, '0')}`,
        roleKey: 'space_reader',
      })),
    ).expect(422);
    await post([{ spaceId: 'nope', roleKey: 'space_reader' }]).expect(422);
    await post([{ spaceId: SPACE, roleKey: 'owner' }]).expect(422);
  });
});
