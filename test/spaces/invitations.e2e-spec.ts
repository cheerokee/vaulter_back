import type { INestApplication } from '@nestjs/common';
import { createTestApp, resetDatabase } from '../setup/test-app.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
  recipientOf,
} from '../support/identity-client.js';
import { activeSpaceMembers, auditRows } from '../support/spaces-db.js';

const MISSING_ID = '0190f3c0-0000-7000-8000-000000000000';

describe('Invitations with spaces and pending grants (e2e)', () => {
  let app: INestApplication;
  const c = identityClient(() => app);
  const s = c.spaces;
  const h = (u: KeyedUser) => c.bearer(u.token);

  let owner: KeyedUser;
  let admin2: KeyedUser;
  let editor: KeyedUser;
  let other: KeyedUser;
  let orgId: string;
  let spaceId: string;
  let spaceKey: Uint8Array;
  let foreignSpaceId: string;

  const inviteWithSpaces = (
    by: KeyedUser,
    spaces: { spaceId: string; roleKey: string }[],
    org = orgId,
  ) =>
    c
      .http()
      .post(`/organizations/${org}/invitations`)
      .set(h(by))
      .send({ roleKey: 'org_member', spaces });

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    owner = await s.signUpKeyed('i-owner@example.com', 'Olivia');
    admin2 = await s.signUpKeyed('i-admin2@example.com', 'Bruno');
    editor = await s.signUpKeyed('i-editor@example.com', 'Edu');
    other = await s.signUpKeyed('i-other@example.com', 'Otto');
    const created = await s.orgWithKit(owner, 'Invites');
    orgId = created.orgId;
    await s.joinOrg(owner, orgId, admin2, 'org_admin');
    await s.joinOrg(owner, orgId, editor);
    const space = await s.create(owner, orgId, created.kit.publicKey, 'Docs');
    spaceId = space.spaceId;
    spaceKey = space.key;
    await expectStatus(
      s.addMember(owner.token, spaceId, recipientOf(editor), [spaceKey]),
      201,
    );
    const foreign = await s.orgWithKit(other, 'Elsewhere');
    foreignSpaceId = (
      await s.create(other, foreign.orgId, foreign.kit.publicKey)
    ).spaceId;
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('indicating a space without being its manager: 403; a space of another organization: 404', async () => {
    const notManager = await inviteWithSpaces(admin2, [
      { spaceId, roleKey: 'space_reader' },
    ]).expect(403);
    expect(notManager.body.type).toMatch(/\/permission-denied$/);
    const foreign = await inviteWithSpaces(owner, [
      { spaceId: foreignSpaceId, roleKey: 'space_reader' },
    ]).expect(404);
    expect(foreign.body.type).toMatch(/\/space-not-found$/);
    // the other organization's manager cannot point at our space either
    const fromOutside = await c
      .http()
      .post(`/organizations/${orgId}/invitations`)
      .set(h(other))
      .send({
        roleKey: 'org_member',
        spaces: [{ spaceId, roleKey: 'space_reader' }],
      })
      .expect(404);
    expect(fromOutside.body.type).toMatch(/\/organization-not-found$/);
  });

  it('accepting creates a pending grant; the manager sees it, seals the key and the person joins', async () => {
    const inv = await inviteWithSpaces(owner, [
      { spaceId, roleKey: 'space_reader' },
    ]).expect(201);
    const guest = await s.signUpKeyed('i-guest@example.com', 'Gina');
    const accepted = await c
      .acceptInvite(guest.token, inv.body.token as string)
      .expect(200);
    expect(accepted.body).toEqual({
      organizationId: orgId,
      roleKey: 'org_member',
    });

    const details = await c
      .http()
      .get(`/spaces/${spaceId}`)
      .set(h(owner))
      .expect(200);
    expect(details.body.pendingGrants).toBe(1);
    const mine = await c
      .http()
      .get(`/organizations/${orgId}/spaces`)
      .set(h(owner))
      .expect(200);
    expect(mine.body.items[0].pendingGrants).toBe(1);

    // an editor cannot see the pending grants
    await c
      .http()
      .get(`/spaces/${spaceId}/pending-grants`)
      .set(h(editor))
      .expect(403);
    const pending = await c
      .http()
      .get(`/spaces/${spaceId}/pending-grants`)
      .set(h(owner))
      .expect(200);
    expect(pending.body.items).toEqual([
      {
        id: expect.any(String),
        userId: guest.userId,
        name: 'Gina',
        email: guest.email,
        publicKey: guest.account.publicKey,
        roleKey: 'space_reader',
        invitationId: inv.body.invitation.id,
        requestedByUserId: owner.userId,
        createdAt: expect.stringMatching(/Z$/),
      },
    ]);
    expect(pending.body.nextCursor).toBeNull();

    const item = pending.body.items[0] as {
      userId: string;
      publicKey: string;
      roleKey: string;
    };
    await expectStatus(
      s.addMember(
        owner.token,
        spaceId,
        { userId: item.userId, publicKey: item.publicKey },
        [spaceKey],
        item.roleKey,
      ),
      201,
    );
    const opened = await s.openKeys(guest, spaceId);
    expect(opened.keys.get(1)).toEqual(spaceKey);
    const after = await c
      .http()
      .get(`/spaces/${spaceId}/pending-grants`)
      .set(h(owner))
      .expect(200);
    expect(after.body.items).toEqual([]);
  });

  it('the manager declines a pending grant by id; a second decline or a foreign id is 404', async () => {
    const inv = await inviteWithSpaces(owner, [
      { spaceId, roleKey: 'space_editor' },
    ]).expect(201);
    const guest = await s.signUpKeyed('i-declined@example.com', 'Dina');
    await c.acceptInvite(guest.token, inv.body.token as string).expect(200);
    const pending = await c
      .http()
      .get(`/spaces/${spaceId}/pending-grants`)
      .set(h(owner))
      .expect(200);
    const id = pending.body.items[0].id as string;

    await c
      .http()
      .delete(`/spaces/${spaceId}/pending-grants/${id}`)
      .set(h(editor))
      .expect(403);
    // the id belongs to this space only
    await c
      .http()
      .delete(`/spaces/${foreignSpaceId}/pending-grants/${id}`)
      .set(h(other))
      .expect(404);
    await c
      .http()
      .delete(`/spaces/${spaceId}/pending-grants/${id}`)
      .set(h(owner))
      .expect(204);
    const again = await c
      .http()
      .delete(`/spaces/${spaceId}/pending-grants/${id}`)
      .set(h(owner))
      .expect(404);
    expect(again.body.type).toMatch(/\/pending-grant-not-found$/);
    await c
      .http()
      .delete(`/spaces/${spaceId}/pending-grants/${MISSING_ID}`)
      .set(h(owner))
      .expect(404);
    expect(
      (
        await c
          .http()
          .get(`/spaces/${spaceId}/pending-grants`)
          .set(h(owner))
          .expect(200)
      ).body.items,
    ).toEqual([]);
    expect(await activeSpaceMembers(spaceId)).not.toContain(guest.userId);
    const audit = await auditRows(orgId, 'space.pending_grant_declined');
    expect(audit).toHaveLength(1);
    expect(audit[0]!.metadata).toMatchObject({
      spaceId,
      pendingGrantId: id,
      targetUserId: guest.userId,
    });
  });
});
