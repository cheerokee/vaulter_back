import type { INestApplication } from '@nestjs/common';
import { CreateInvitationUseCase } from '../../src/organizations/application/create-invitation.use-case.js';
import { CreateOrganizationUseCase } from '../../src/organizations/application/create-organization.use-case.js';
import { RevokeInvitationUseCase } from '../../src/organizations/application/revoke-invitation.use-case.js';
import { RegistrationHooks } from '../../src/shared/application/registration-hooks.js';
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
const TABLES = [
  'users',
  'user_sessions',
  'organizations',
  'user_organization',
  'role_assignments',
  'audit_logs',
  'organization_invitations',
] as const;

describe('Registration creates the personal organization (e2e)', () => {
  let app: INestApplication;
  let account: ClientAccount;
  const client = identityClient(() => app);

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> => (await adminDataSource()).query(query, params);

  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of TABLES) {
      const rows = await sql<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${t}`,
      );
      out[t] = Number(rows[0]!.n);
    }
    return out;
  };

  const membershipOf = (orgId: string, userId: string) =>
    sql<{ role_key: string }>(
      `SELECT r.key AS role_key
         FROM user_organization uo
         JOIN role_assignments ra ON ra.organization_id = uo.organization_id
          AND ra.user_id = uo.user_id AND ra.deleted_at IS NULL AND ra.scope_type = 'organization'
         JOIN roles r ON r.id = ra.role_id
        WHERE uo.organization_id = $1 AND uo.user_id = $2 AND uo.deleted_at IS NULL`,
      [orgId, userId],
    );

  const personalOrgOf = (userId: string) =>
    sql<{ id: string; is_personal: boolean }>(
      `SELECT id, is_personal FROM organizations WHERE personal_owner_user_id = $1`,
      [userId],
    );

  const invitationStatus = async (id: string) =>
    (
      await sql<{ status: string }>(
        `SELECT status FROM organization_invitations WHERE id = $1`,
        [id],
      )
    )[0]!.status;

  /** Registers the owner and creates an organization with one invitation (use cases: no HTTP routes yet). */
  async function orgWithInvite(
    ownerEmail: string,
    input: { roleKey?: 'org_admin' | 'org_member'; email?: string } = {},
  ) {
    const reg = await client.register(account, ownerEmail).expect(201);
    const actor = { userId: reg.body.user.id as string, sessionId: 's' };
    const org = await app.get(CreateOrganizationUseCase).execute(actor, {
      name: 'Acme',
    });
    const { invitation, token } = await app
      .get(CreateInvitationUseCase)
      .execute(actor, org.id, {
        roleKey: input.roleKey ?? 'org_member',
        email: input.email ?? null,
      });
    return { actor, orgId: org.id, invitationId: invitation.id, token };
  }

  beforeAll(async () => {
    app = await createTestApp();
    await resetDatabase();
    account = await createClientAccount(PASSWORD);
  }, 60_000);
  afterAll(async () => {
    await app.close();
  });

  it('without an invite: personal organization owned by the user, who is its org_admin; no invitation key', async () => {
    const res = await client.register(account, 'solo@example.com').expect(201);
    expect('invitation' in res.body).toBe(false);
    const userId = res.body.user.id as string;
    const orgs = await personalOrgOf(userId);
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.is_personal).toBe(true);
    expect(await membershipOf(orgs[0]!.id, userId)).toEqual([
      { role_key: 'org_admin' },
    ]);
  }, 60_000);

  it('with a valid invite: joins the invited organization with the invited role AND gets the personal one', async () => {
    const inv = await orgWithInvite('owner-valid@example.com', {
      roleKey: 'org_admin',
    });
    const res = await client
      .register(account, 'guest@example.com', { inviteToken: inv.token })
      .expect(201);
    expect(res.body.invitation).toEqual({ accepted: true });
    const userId = res.body.user.id as string;
    expect(await membershipOf(inv.orgId, userId)).toEqual([
      { role_key: 'org_admin' },
    ]);
    const personal = await personalOrgOf(userId);
    expect(personal).toHaveLength(1);
    expect(await membershipOf(personal[0]!.id, userId)).toEqual([
      { role_key: 'org_admin' },
    ]);
    expect(await invitationStatus(inv.invitationId)).toBe('accepted');
    const audit = await sql(
      `SELECT 1 FROM audit_logs WHERE organization_id = $1 AND user_id = $2 AND action = 'member.joined'`,
      [inv.orgId, userId],
    );
    expect(audit).toHaveLength(1);
  }, 60_000);

  describe('invalid invites do not block the sign-up', () => {
    const memberCount = async (orgId: string) =>
      Number(
        (
          await sql<{ n: string }>(
            `SELECT count(*)::text AS n FROM user_organization WHERE organization_id = $1 AND deleted_at IS NULL`,
            [orgId],
          )
        )[0]!.n,
      );

    async function expectRejectedInvite(
      email: string,
      inv: { orgId: string; invitationId: string; token: string },
      expectedStatus: string,
    ) {
      const membersBefore = await memberCount(inv.orgId);
      const res = await client
        .register(account, email, { inviteToken: inv.token })
        .expect(201);
      expect(res.body.invitation).toEqual({ accepted: false });
      const userId = res.body.user.id as string;
      expect(await personalOrgOf(userId)).toHaveLength(1);
      expect(await membershipOf(inv.orgId, userId)).toHaveLength(0);
      expect(await memberCount(inv.orgId)).toBe(membersBefore);
      expect(await invitationStatus(inv.invitationId)).toBe(expectedStatus);
    }

    it('expired', async () => {
      const inv = await orgWithInvite('owner-exp@example.com');
      await sql(
        `UPDATE organization_invitations SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [inv.invitationId],
      );
      await expectRejectedInvite('late@example.com', inv, 'pending');
    }, 60_000);

    it('revoked', async () => {
      const inv = await orgWithInvite('owner-rev@example.com');
      await app
        .get(RevokeInvitationUseCase)
        .execute(inv.actor, inv.orgId, inv.invitationId);
      await expectRejectedInvite('revoked@example.com', inv, 'revoked');
    }, 60_000);

    it('already used', async () => {
      const inv = await orgWithInvite('owner-used@example.com');
      const first = await client
        .register(account, 'first@example.com', { inviteToken: inv.token })
        .expect(201);
      expect(first.body.invitation).toEqual({ accepted: true });
      await expectRejectedInvite('second@example.com', inv, 'accepted');
    }, 60_000);

    it('addressed to another e-mail', async () => {
      const inv = await orgWithInvite('owner-other@example.com', {
        email: 'someone@else.com',
      });
      await expectRejectedInvite('intruder@example.com', inv, 'pending');
    }, 60_000);
  });

  describe('a failure inside the hook path undoes everything', () => {
    const SECRET = 'boom-secret-marker-7731';

    async function registerWithFailingHook(
      email: string,
      over: Record<string, unknown> = {},
    ) {
      const hooks = app.get(RegistrationHooks);
      // Registered after the organizations hook: it runs once the personal organization (and the invite
      // acceptance, when there is one) already hit the database.
      hooks.register({
        name: 'test-after-org-throwing',
        onRegistered: async () => {
          throw new Error(SECRET);
        },
      });
      try {
        return await client.register(account, email, over);
      } finally {
        hooks.unregister('test-after-org-throwing');
      }
    }

    function expectGenericProblem(res: {
      status: number;
      headers: Record<string, string>;
      body: unknown;
      text: string;
    }) {
      expect(res.status).toBe(500);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.body).toMatchObject({
        status: 500,
        detail: 'An unexpected error occurred',
      });
      expect(res.text).not.toContain(SECRET);
      expect(res.text).not.toMatch(/\n\s+at |stack|\.ts:\d+|\.js:\d+/);
    }

    it('plain sign-up: no user, session, organization, membership, role or audit row is left', async () => {
      const before = await counts();
      const res = await registerWithFailingHook('fail-plain@example.com');
      expectGenericProblem(res);
      expect(await counts()).toEqual(before);
      // The e-mail is free again.
      await client.register(account, 'fail-plain@example.com').expect(201);
    }, 60_000);

    it('sign-up with a valid invite: the acceptance is undone too, and the invite is still pending', async () => {
      const inv = await orgWithInvite('owner-fail@example.com');
      const before = await counts();
      const res = await registerWithFailingHook('fail-invite@example.com', {
        inviteToken: inv.token,
      });
      expectGenericProblem(res);
      expect(await counts()).toEqual(before);
      expect(await invitationStatus(inv.invitationId)).toBe('pending');
      // The same invite still works for a later, healthy sign-up.
      const ok = await client
        .register(account, 'fail-invite@example.com', {
          inviteToken: inv.token,
        })
        .expect(201);
      expect(ok.body.invitation).toEqual({ accepted: true });
    }, 60_000);
  });
});
