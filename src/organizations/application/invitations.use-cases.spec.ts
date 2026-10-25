import { Logger } from '@nestjs/common';
import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { SeatPolicy } from '../domain/seat-policy.js';
import type { Invitation } from '../domain/invitation.js';
import {
  ADMIN,
  MEMBER,
  NOW,
  ORG_ID,
  STRANGER,
  TOKEN,
  TOKEN_HASH,
  actor,
  makeInvitation,
  makeKit,
} from '../../../test/support/organizations-kit.js';
import { AcceptInvitationUseCase } from './accept-invitation.use-case.js';
import { CreateInvitationUseCase } from './create-invitation.use-case.js';
import { ListInvitationsUseCase } from './list-invitations.use-case.js';
import { PreviewInvitationUseCase } from './preview-invitation.use-case.js';
import { RevokeInvitationUseCase } from './revoke-invitation.use-case.js';

const kit = makeKit();
const d = kit.deps;
const m = kit.mocks;
const INV_ID = '019a1b2c-0000-7000-8000-0000000000e1';

beforeEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  kit.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('CreateInvitationUseCase', () => {
  const useCase = () =>
    new CreateInvitationUseCase(
      d.access,
      d.orgs,
      d.memberships,
      d.invitations,
      d.codec,
      d.audit,
      d.uow,
    );

  it('issues the invitation with only the hash stored, returns the token once and audits without it', async () => {
    const logSpies = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(Logger.prototype, 'log'),
      vi.spyOn(Logger, 'log'),
    ];
    const out = await useCase().execute(actor(ADMIN), ORG_ID, {
      roleKey: 'org_member',
      email: ' Bob@X.com ',
    });
    const stored = m.invitations.create.mock.calls[0]![0] as Invitation;
    expect(stored.tokenHash).toBe(TOKEN_HASH);
    expect(stored.email).toBe('bob@x.com');
    expect(stored.createdBy).toBe(ADMIN);
    expect(out.token).toBe(TOKEN);
    expect(out.invitation).toEqual({
      id: stored.id,
      organizationId: ORG_ID,
      email: 'bob@x.com',
      roleKey: 'org_member',
      status: 'pending',
      expiresAt: new Date('2026-11-01T12:00:00Z'),
      createdBy: ADMIN,
      createdAt: NOW,
    });
    expect(JSON.stringify(out.invitation)).not.toContain(TOKEN_HASH);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'invitation.created',
        metadata: { invitationId: stored.id, roleKey: 'org_member' },
      },
    ]);
    const audited = JSON.stringify(kit.audited());
    expect(audited).not.toContain(TOKEN);
    expect(audited).not.toContain(TOKEN_HASH);
    for (const spy of logSpies) {
      expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN);
    }
    expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
  });

  it('checks the seat limit with the active member count', async () => {
    const seat = vi
      .spyOn(SeatPolicy, 'assertSeatAvailable')
      .mockImplementation(() => {
        throw new ConflictError('seat-limit-reached', 'full');
      });
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, { roleKey: 'org_member' }),
    ).rejects.toMatchObject({ code: 'seat-limit-reached' });
    expect(seat).toHaveBeenCalledWith(2, 'free');
    expect(m.invitations.create).not.toHaveBeenCalled();
  });

  it('accepts only org_admin or org_member', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, {
        roleKey: 'hub_owner' as never,
      }),
    ).rejects.toMatchObject({ code: 'role-invalid' });
    expect(m.invitations.create).not.toHaveBeenCalled();
  });

  it('403 for a member, 404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(MEMBER), ORG_ID, { roleKey: 'org_member' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, { roleKey: 'org_member' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.codec.generate).not.toHaveBeenCalled();
  });
});

describe('ListInvitationsUseCase', () => {
  const useCase = () => new ListInvitationsUseCase(d.access, d.invitations);

  it('lists pending invitations (admin), using the same clock as the acceptance', async () => {
    m.invitations.listPending.mockResolvedValue({
      items: [makeInvitation()],
      nextCursor: null,
    });
    const page = { limit: 10 };
    const out = await useCase().execute(actor(ADMIN), ORG_ID, page);
    expect(m.invitations.listPending).toHaveBeenCalledWith(ORG_ID, page, NOW);
    expect(out.items[0]).toMatchObject({ id: INV_ID, status: 'pending' });
    expect(JSON.stringify(out)).not.toContain(TOKEN_HASH);
  });

  it('403 for a member, 404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(MEMBER), ORG_ID, { limit: 10 }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, { limit: 10 }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('RevokeInvitationUseCase', () => {
  const useCase = () =>
    new RevokeInvitationUseCase(d.access, d.invitations, d.audit, d.uow);

  it('revokes and audits invitation.revoked', async () => {
    await useCase().execute(actor(ADMIN), ORG_ID, INV_ID);
    expect(m.invitations.revoke).toHaveBeenCalledWith(ORG_ID, INV_ID);
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'invitation.revoked',
        metadata: { invitationId: INV_ID },
      },
    ]);
  });

  it('404 invitation-not-found when nothing pending was revoked (or the id is malformed)', async () => {
    m.invitations.revoke.mockResolvedValue(false);
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, INV_ID),
    ).rejects.toMatchObject({ code: 'invitation-not-found' });
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, 'nope'),
    ).rejects.toMatchObject({ code: 'invitation-not-found' });
    expect(m.auditRepo.append).not.toHaveBeenCalled();
  });

  it('403 for a member, 404 for a non-member', async () => {
    await expect(
      useCase().execute(actor(MEMBER), ORG_ID, INV_ID),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, INV_ID),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(m.invitations.revoke).not.toHaveBeenCalled();
  });
});

describe('PreviewInvitationUseCase', () => {
  const useCase = () =>
    new PreviewInvitationUseCase(
      d.codec,
      d.invitations,
      d.orgs,
      d.directory,
      d.access,
      d.uow,
    );

  it('shows only the organization name, the inviter name and the deadline (no e-mail)', async () => {
    m.invitations.findByTokenHash.mockResolvedValue(
      makeInvitation({ email: 'bob@x.com' }),
    );
    const out = await useCase().execute(TOKEN);
    expect(m.invitations.findByTokenHash).toHaveBeenCalledWith(TOKEN_HASH);
    expect(out).toEqual({
      organizationName: 'Acme',
      invitedByName: 'name-a1',
      expiresAt: new Date('2026-10-30T12:00:00Z'),
    });
    expect(JSON.stringify(out)).not.toContain('@');
  });

  it.each([
    ['malformed token', 'bad', null],
    ['unknown token', TOKEN, null],
    ['revoked', TOKEN, makeInvitation({ status: 'revoked' })],
    ['accepted', TOKEN, makeInvitation({ status: 'accepted' })],
    ['expired', TOKEN, makeInvitation({ expiresAt: NOW })],
  ])('%s -> invitation-invalid', async (_label, token, invitation) => {
    m.invitations.findByTokenHash.mockResolvedValue(invitation);
    const err = await useCase()
      .execute(token as string)
      .catch((e) => e);
    expect(err).toBeInstanceOf(DomainValidationError);
    expect(err.code).toBe('invitation-invalid');
  });

  it.each([
    ['removed', () => kit.members.delete(ADMIN)],
    ['demoted', () => kit.members.set(ADMIN, 'org_member')],
  ])(
    'creator %s since issuing -> invitation-invalid (checked in the unit of work)',
    async (_label, lose) => {
      m.invitations.findByTokenHash.mockResolvedValue(makeInvitation());
      lose();
      await expect(useCase().execute(TOKEN)).rejects.toMatchObject({
        code: 'invitation-invalid',
      });
      expect(m.memberships.find).toHaveBeenCalledWith(ORG_ID, ADMIN);
      expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
    },
  );

  it('a malformed token never reaches the repository', async () => {
    await useCase()
      .execute('bad')
      .catch(() => undefined);
    expect(m.invitations.findByTokenHash).not.toHaveBeenCalled();
  });
});

describe('AcceptInvitationUseCase', () => {
  const useCase = () =>
    new AcceptInvitationUseCase(
      d.codec,
      d.invitations,
      d.orgs,
      d.memberships,
      d.roles,
      d.directory,
      d.audit,
      d.uow,
      d.access,
    );
  const invited = (overrides = {}) =>
    m.invitations.findByTokenHash.mockResolvedValue(makeInvitation(overrides));

  it('joins the organization with the invitation role, atomically consumes it and audits member.joined', async () => {
    invited({ roleKey: 'org_admin', email: 'c1@x.com' });
    const out = await useCase().execute(actor(STRANGER), TOKEN);
    expect(m.directory.findPublicByIds).toHaveBeenCalledWith([STRANGER]);
    expect(m.invitations.markAccepted).toHaveBeenCalledWith(
      ORG_ID,
      INV_ID,
      STRANGER,
      NOW,
    );
    expect(m.memberships.add).toHaveBeenCalledWith(ORG_ID, STRANGER, NOW);
    expect(m.roles.assignOrgRole).toHaveBeenCalledWith(
      ORG_ID,
      STRANGER,
      'org_admin',
      ADMIN,
    );
    expect(out).toEqual({
      organizationId: ORG_ID,
      roleKey: 'org_admin',
      alreadyMember: false,
    });
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: STRANGER,
        action: 'member.joined',
        metadata: { invitationId: INV_ID, roleKey: 'org_admin' },
      },
    ]);
    expect(JSON.stringify(kit.audited())).not.toContain(TOKEN);
    // consume before joining, everything inside the unit of work
    const writes = kit.trace.filter((t) =>
      /markAccepted|memberships.add|assignOrgRole|audit/.test(t),
    );
    expect(writes).toEqual([
      'invitations.markAccepted',
      'memberships.add',
      'roles.assignOrgRole',
      'audit.append',
    ]);
    expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
  });

  it('e-mail invitation for another account -> invitation-invalid, nothing written', async () => {
    invited({ email: 'someone@else.com' });
    await expect(
      useCase().execute(actor(STRANGER), TOKEN),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
    expect(m.invitations.markAccepted).not.toHaveBeenCalled();
    expect(m.memberships.add).not.toHaveBeenCalled();
  });

  it('lost the race (markAccepted false) -> invitation-invalid, no membership', async () => {
    invited();
    m.invitations.markAccepted.mockResolvedValue(false);
    await expect(
      useCase().execute(actor(STRANGER), TOKEN),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
    expect(m.memberships.add).not.toHaveBeenCalled();
    expect(m.auditRepo.append).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed token', 'bad', null],
    ['unknown token', TOKEN, null],
    ['revoked', TOKEN, makeInvitation({ status: 'revoked' })],
    ['already accepted', TOKEN, makeInvitation({ status: 'accepted' })],
    ['expired', TOKEN, makeInvitation({ expiresAt: NOW })],
  ])('%s -> invitation-invalid', async (_label, token, invitation) => {
    m.invitations.findByTokenHash.mockResolvedValue(invitation);
    await expect(
      useCase().execute(actor(STRANGER), token as string),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
    expect(m.memberships.add).not.toHaveBeenCalled();
  });

  it('checks the seat limit before consuming the invitation', async () => {
    invited();
    const seat = vi
      .spyOn(SeatPolicy, 'assertSeatAvailable')
      .mockImplementation(() => {
        throw new ConflictError('seat-limit-reached', 'full');
      });
    await expect(
      useCase().execute(actor(STRANGER), TOKEN),
    ).rejects.toMatchObject({ code: 'seat-limit-reached' });
    expect(seat).toHaveBeenCalledWith(2, 'free');
    expect(m.invitations.markAccepted).not.toHaveBeenCalled();
  });

  it('an existing member consumes the invitation without a duplicate membership and keeps their role', async () => {
    invited({ roleKey: 'org_member' });
    const out = await useCase().execute(actor(ADMIN), TOKEN);
    expect(m.invitations.markAccepted).toHaveBeenCalledWith(
      ORG_ID,
      INV_ID,
      ADMIN,
      NOW,
    );
    expect(m.memberships.add).not.toHaveBeenCalled();
    expect(m.roles.assignOrgRole).not.toHaveBeenCalled();
    expect(m.auditRepo.append).not.toHaveBeenCalled();
    expect(out).toEqual({
      organizationId: ORG_ID,
      roleKey: 'org_admin',
      alreadyMember: true,
    });
  });

  it.each([
    ['removed', () => kit.members.delete(ADMIN)],
    ['demoted', () => kit.members.set(ADMIN, 'org_member')],
  ])(
    'creator %s since issuing -> invitation-invalid, nothing written',
    async (_label, lose) => {
      invited({ roleKey: 'org_admin' });
      lose();
      await expect(
        useCase().execute(actor(STRANGER), TOKEN),
      ).rejects.toMatchObject({ code: 'invitation-invalid' });
      expect(m.memberships.find).toHaveBeenCalledWith(ORG_ID, ADMIN);
      expect(m.invitations.markAccepted).not.toHaveBeenCalled();
      expect(m.memberships.add).not.toHaveBeenCalled();
      expect(m.roles.assignOrgRole).not.toHaveBeenCalled();
      expect(m.auditRepo.append).not.toHaveBeenCalled();
    },
  );

  it('the removed creator cannot come back through their own invitation', async () => {
    invited({ roleKey: 'org_admin' });
    kit.members.delete(ADMIN);
    await expect(useCase().execute(actor(ADMIN), TOKEN)).rejects.toMatchObject({
      code: 'invitation-invalid',
    });
    expect(m.memberships.add).not.toHaveBeenCalled();
  });

  it('an existing member cannot consume an invitation whose creator lost the permission', async () => {
    invited();
    kit.members.set(ADMIN, 'org_member');
    await expect(useCase().execute(actor(MEMBER), TOKEN)).rejects.toMatchObject(
      { code: 'invitation-invalid' },
    );
    expect(m.invitations.markAccepted).not.toHaveBeenCalled();
  });

  it('acceptAs (registration path) also refuses when the creator lost the permission', async () => {
    invited({ email: 'new@x.com' });
    kit.members.delete(ADMIN);
    await expect(
      useCase().acceptAs({ userId: STRANGER, email: 'new@x.com' }, TOKEN, NOW),
    ).rejects.toMatchObject({ code: 'invitation-invalid' });
    expect(m.memberships.add).not.toHaveBeenCalled();
  });

  it('acceptAs uses the given e-mail without the directory (registration path)', async () => {
    invited({ email: 'new@x.com' });
    await useCase().acceptAs(
      { userId: STRANGER, email: 'New@X.com' },
      TOKEN,
      NOW,
    );
    expect(m.directory.findPublicByIds).not.toHaveBeenCalled();
    expect(m.memberships.add).toHaveBeenCalledWith(ORG_ID, STRANGER, NOW);
  });
});
