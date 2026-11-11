import {
  ADMIN,
  MEMBER,
  NOW,
  ORG_ID,
  STRANGER,
  makeKit,
  makeOrganization,
} from '../../../test/support/organizations-kit.js';
import type { Organization } from '../domain/organization.js';
import type { AuditActor } from '../../shared/application/audit-actor.js';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { AiBudgetRaisedHooks } from '../../shared/application/ai-budget-raised-hooks.js';
import { OrganizationAdministration } from './organization-administration.js';

const PLATFORM: AuditActor = { kind: 'platform', supportRequestId: 'sr-1' };
const PLATFORM_META = { actor: 'platform', supportRequestId: 'sr-1' };

describe('OrganizationAdministration', () => {
  const kit = makeKit();
  let raisedHooks = new AiBudgetRaisedHooks();
  const admin = () =>
    new OrganizationAdministration(
      kit.deps.orgs,
      kit.deps.memberships,
      kit.deps.roles,
      kit.deps.directory,
      kit.deps.audit,
      kit.deps.uow,
      raisedHooks,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    kit.reset();
  });

  describe('appointAdmin', () => {
    it('a current member: org_admin under the admin lock, in the organization context, member.role_changed by the platform', async () => {
      await expect(
        admin().appointAdmin(ORG_ID, MEMBER, PLATFORM, NOW),
      ).resolves.toEqual({ joined: false });
      expect(kit.trace[0]).toBe(
        `uow.withContext:${JSON.stringify({ organizationId: ORG_ID })}`,
      );
      expect(kit.trace.indexOf('roles.lockOrgAdmins')).toBeLessThan(
        kit.trace.indexOf('memberships.find'),
      );
      expect(kit.mocks.roles.assignOrgRole).toHaveBeenCalledWith(
        ORG_ID,
        MEMBER,
        'org_admin',
        null,
      );
      expect(kit.mocks.memberships.add).not.toHaveBeenCalled();
      expect(kit.audited()).toEqual([
        {
          organizationId: ORG_ID,
          userId: null,
          action: 'member.role_changed',
          metadata: {
            targetUserId: MEMBER,
            from: 'org_member',
            to: 'org_admin',
            ...PLATFORM_META,
          },
        },
      ]);
    });

    it('a registered non-member: seat check, membership, member.joined, then org_admin and member.role_changed', async () => {
      await expect(
        admin().appointAdmin(ORG_ID, STRANGER, PLATFORM, NOW),
      ).resolves.toEqual({ joined: true });
      expect(kit.mocks.memberships.countActive).toHaveBeenCalledWith(ORG_ID);
      expect(kit.mocks.memberships.add).toHaveBeenCalledWith(
        ORG_ID,
        STRANGER,
        NOW,
      );
      expect(kit.trace.indexOf('memberships.add')).toBeLessThan(
        kit.trace.indexOf('roles.assignOrgRole'),
      );
      expect(kit.audited()).toEqual([
        {
          organizationId: ORG_ID,
          userId: null,
          action: 'member.joined',
          metadata: {
            targetUserId: STRANGER,
            roleKey: 'org_admin',
            ...PLATFORM_META,
          },
        },
        {
          organizationId: ORG_ID,
          userId: null,
          action: 'member.role_changed',
          metadata: {
            targetUserId: STRANGER,
            from: null,
            to: 'org_admin',
            ...PLATFORM_META,
          },
        },
      ]);
    });

    it('a user actor is recorded as the audit user and the grantor', async () => {
      await admin().appointAdmin(
        ORG_ID,
        MEMBER,
        { kind: 'user', userId: ADMIN },
        NOW,
      );
      expect(kit.mocks.roles.assignOrgRole).toHaveBeenCalledWith(
        ORG_ID,
        MEMBER,
        'org_admin',
        ADMIN,
      );
      expect(kit.audited()).toEqual([
        {
          organizationId: ORG_ID,
          userId: ADMIN,
          action: 'member.role_changed',
          metadata: {
            targetUserId: MEMBER,
            from: 'org_member',
            to: 'org_admin',
          },
        },
      ]);
    });

    it('already org_admin: nothing is written', async () => {
      await expect(
        admin().appointAdmin(ORG_ID, ADMIN, PLATFORM, NOW),
      ).resolves.toEqual({ joined: false });
      expect(kit.mocks.roles.assignOrgRole).not.toHaveBeenCalled();
      expect(kit.audited()).toEqual([]);
      expect(kit.mocks.orgs.lockForUpdate).not.toHaveBeenCalled();
      expect(kit.mocks.orgs.save).not.toHaveBeenCalled();
    });

    it('an appointment that writes starts the protection window, saved under the organization lock after the admin lock', async () => {
      await admin().appointAdmin(ORG_ID, MEMBER, PLATFORM, NOW);
      const t = kit.trace;
      expect(t.indexOf('roles.lockOrgAdmins')).toBeLessThan(
        t.indexOf('orgs.lockForUpdate'),
      );
      expect(t.indexOf('orgs.lockForUpdate')).toBeLessThan(
        t.indexOf('orgs.save'),
      );
      const saved = kit.mocks.orgs.save.mock.calls[0]![0] as Organization;
      expect(saved.platformAppointment).toEqual({
        appointedUserId: MEMBER,
        appointedAt: NOW,
        protectedUntil: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      });
    });

    it('a user actor appointment does not open the protection window', async () => {
      await admin().appointAdmin(
        ORG_ID,
        MEMBER,
        { kind: 'user', userId: ADMIN },
        NOW,
      );
      expect(kit.mocks.roles.assignOrgRole).toHaveBeenCalled();
      expect(kit.mocks.orgs.lockForUpdate).not.toHaveBeenCalled();
      expect(kit.mocks.orgs.save).not.toHaveBeenCalled();
    });

    it('a registered non-member appointed also starts the window', async () => {
      await admin().appointAdmin(ORG_ID, STRANGER, PLATFORM, NOW);
      const saved = kit.mocks.orgs.save.mock.calls[0]![0] as Organization;
      expect(saved.platformAppointment?.appointedUserId).toBe(STRANGER);
    });

    it('re-appointing an existing admin does not restart the window; a new appointment does', async () => {
      const first = new Date(NOW.getTime() - 3 * 24 * 60 * 60 * 1000);
      const org = makeOrganization();
      org.recordPlatformAppointment(ADMIN, first);
      kit.setOrganization(org);
      await admin().appointAdmin(ORG_ID, ADMIN, PLATFORM, NOW);
      expect(kit.mocks.orgs.save).not.toHaveBeenCalled();
      expect(org.platformAppointment?.appointedAt).toEqual(first);

      await admin().appointAdmin(ORG_ID, MEMBER, PLATFORM, NOW);
      expect(org.platformAppointment).toMatchObject({
        appointedUserId: MEMBER,
        appointedAt: NOW,
      });
    });

    it('a personal organization is refused (422 personal-organization-protected)', async () => {
      kit.setOrganization(
        makeOrganization({ isPersonal: true, personalOwnerUserId: ADMIN }),
      );
      const err = await admin()
        .appointAdmin(ORG_ID, MEMBER, PLATFORM, NOW)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DomainValidationError);
      expect(err).toMatchObject({ code: 'personal-organization-protected' });
      expect(kit.mocks.roles.lockOrgAdmins).not.toHaveBeenCalled();
      expect(kit.audited()).toEqual([]);
    });

    it('unknown or malformed organization: 404 organization-not-found', async () => {
      for (const id of ['019a1b2c-0000-7000-8000-00000000dead', 'nope']) {
        const err = await admin()
          .appointAdmin(id, MEMBER, PLATFORM, NOW)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err).toMatchObject({ code: 'organization-not-found' });
      }
    });

    it('unknown or malformed user: 404 user-not-found', async () => {
      kit.mocks.directory.findPublicByIds.mockResolvedValueOnce([]);
      for (const id of ['019a1b2c-0000-7000-8000-00000000dead', 'nope']) {
        const err = await admin()
          .appointAdmin(ORG_ID, id, PLATFORM, NOW)
          .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(NotFoundError);
        expect(err).toMatchObject({ code: 'user-not-found' });
      }
      expect(kit.audited()).toEqual([]);
    });

    it('the seat policy error propagates before any write', async () => {
      const { SeatPolicy } = await import('../domain/seat-policy.js');
      const spy = vi
        .spyOn(SeatPolicy, 'assertSeatAvailable')
        .mockImplementation(() => {
          throw new ConflictError('seat-limit-reached', 'full');
        });
      try {
        await expect(
          admin().appointAdmin(ORG_ID, STRANGER, PLATFORM, NOW),
        ).rejects.toMatchObject({ code: 'seat-limit-reached' });
      } finally {
        spy.mockRestore();
      }
      expect(kit.mocks.memberships.add).not.toHaveBeenCalled();
      expect(kit.audited()).toEqual([]);
    });
  });

  describe('setAiBudget', () => {
    const FINANCE: AuditActor = {
      kind: 'platform_staff',
      staffAction: 'ai_budget_changed',
    };
    const raised = vi.fn(async () => {
      kit.trace.push('hook.raised');
    });
    beforeEach(() => {
      raisedHooks = new AiBudgetRaisedHooks();
      raisedHooks.register({ name: 't', onAiBudgetRaised: raised });
      raised.mockClear();
    });

    it('a raise: locks the organization, saves, audits, then runs the raised hooks inside the unit of work', async () => {
      await expect(
        admin().setAiBudget(ORG_ID, 5_000_000n, FINANCE),
      ).resolves.toEqual({ fromMicroUsd: 0n, toMicroUsd: 5_000_000n });
      const t = kit.trace;
      expect(t.indexOf('orgs.lockForUpdate')).toBeLessThan(
        t.indexOf('orgs.save'),
      );
      expect(t.indexOf('orgs.save')).toBeLessThan(t.indexOf('hook.raised'));
      const saved = kit.mocks.orgs.save.mock.calls[0]![0] as Organization;
      expect(saved.aiBudgetMicroUsd).toBe(5_000_000n);
      expect(raised).toHaveBeenCalledWith({
        organizationId: ORG_ID,
        fromMicroUsd: 0n,
        toMicroUsd: 5_000_000n,
      });
      expect(kit.audited()).toEqual([
        {
          organizationId: ORG_ID,
          userId: null,
          action: 'organization.ai_budget_changed',
          metadata: {
            actor: 'platform',
            staffAction: 'ai_budget_changed',
            fromMicroUsd: 0,
            toMicroUsd: 5_000_000,
          },
        },
      ]);
    });

    it('a cut writes and audits but does not run the raised hooks; the same value writes nothing', async () => {
      kit.mocks.orgs.lockForUpdate.mockResolvedValueOnce(
        makeOrganization({ aiBudgetMicroUsd: 9n }),
      );
      await admin().setAiBudget(ORG_ID, 0n, FINANCE);
      expect(kit.mocks.orgs.save).toHaveBeenCalledTimes(1);
      expect(raised).not.toHaveBeenCalled();
      kit.mocks.orgs.lockForUpdate.mockResolvedValueOnce(
        makeOrganization({ aiBudgetMicroUsd: 9n }),
      );
      await admin().setAiBudget(ORG_ID, 9n, FINANCE);
      expect(kit.mocks.orgs.save).toHaveBeenCalledTimes(1);
      expect(kit.audited()).toHaveLength(1);
    });

    it('negative budget: 422 ai-budget-invalid; malformed or unknown organization: 404', async () => {
      await expect(
        admin().setAiBudget(ORG_ID, -1n, FINANCE),
      ).rejects.toMatchObject({ code: 'ai-budget-invalid' });
      await expect(
        admin().setAiBudget('nope', 1n, FINANCE),
      ).rejects.toBeInstanceOf(NotFoundError);
      kit.mocks.orgs.lockForUpdate.mockResolvedValueOnce(null);
      await expect(
        admin().setAiBudget(ORG_ID, 1n, FINANCE),
      ).rejects.toBeInstanceOf(NotFoundError);
      expect(kit.mocks.orgs.save).not.toHaveBeenCalled();
    });
  });

  describe('summary', () => {
    it('name, personal flag, admins and member count; null for an unknown or malformed organization', async () => {
      await expect(admin().summary(ORG_ID)).resolves.toEqual({
        organizationId: ORG_ID,
        name: 'Acme',
        personal: false,
        adminUserIds: [ADMIN],
        memberCount: 2,
      });
      expect(kit.mocks.roles.lockOrgAdmins).not.toHaveBeenCalled();
      await expect(
        admin().summary('019a1b2c-0000-7000-8000-00000000dead'),
      ).resolves.toBeNull();
      await expect(admin().summary('nope')).resolves.toBeNull();
    });
  });
});
