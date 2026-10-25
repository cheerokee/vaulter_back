import {
  ConflictError,
  DomainValidationError,
} from '../../shared/domain/errors.js';
import type { RegistrationHooks } from '../../shared/application/registration-hooks.js';
import {
  NOW,
  STRANGER,
  TOKEN,
  makeKit,
} from '../../../test/support/organizations-kit.js';
import type { AcceptInvitationUseCase } from './accept-invitation.use-case.js';
import type { CreateOrganizationUseCase } from './create-organization.use-case.js';
import { PersonalOrganizationRegistrationHook } from './personal-organization.registration-hook.js';

const kit = makeKit();
const hooks = { register: vi.fn(), unregister: vi.fn() };
const createOrganization = { createPersonal: vi.fn() };
const acceptInvitation = { acceptAs: vi.fn() };
const ctx = { userId: STRANGER, name: 'Ana', email: 'ana@x.com', now: NOW };

function makeHook() {
  return new PersonalOrganizationRegistrationHook(
    hooks as unknown as RegistrationHooks,
    createOrganization as unknown as CreateOrganizationUseCase,
    acceptInvitation as unknown as AcceptInvitationUseCase,
    kit.deps.uow,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
  createOrganization.createPersonal.mockResolvedValue({ id: 'org' });
  acceptInvitation.acceptAs.mockResolvedValue({
    organizationId: 'o2',
    roleKey: 'org_member',
    alreadyMember: false,
  });
});

describe('PersonalOrganizationRegistrationHook', () => {
  it('subscribes on module init and unsubscribes on destroy', () => {
    const hook = makeHook();
    hook.onModuleInit();
    expect(hooks.register).toHaveBeenCalledWith({
      name: 'organizations.personal',
      onRegistered: expect.any(Function),
    });
    hook.onModuleDestroy();
    expect(hooks.unregister).toHaveBeenCalledWith('organizations.personal');
  });

  it('creates the personal organization and returns nothing without an invite', async () => {
    const out = await makeHook().onRegistered(ctx);
    expect(createOrganization.createPersonal).toHaveBeenCalledWith({
      ownerId: STRANGER,
      name: 'Ana',
      now: NOW,
    });
    expect(acceptInvitation.acceptAs).not.toHaveBeenCalled();
    expect(out).toBeUndefined();
  });

  it('accepts the invite with the new account e-mail inside a nested unit of work (savepoint)', async () => {
    let depth = 0;
    kit.mocks.uow.run.mockImplementation(
      async (work: () => Promise<unknown>) => {
        depth++;
        try {
          return await work();
        } finally {
          depth--;
        }
      },
    );
    acceptInvitation.acceptAs.mockImplementation(async () => {
      expect(depth).toBeGreaterThanOrEqual(1);
      return {
        organizationId: 'o2',
        roleKey: 'org_member',
        alreadyMember: false,
      };
    });
    const out = await makeHook().onRegistered({ ...ctx, inviteToken: TOKEN });
    expect(acceptInvitation.acceptAs).toHaveBeenCalledWith(
      { userId: STRANGER, email: 'ana@x.com' },
      TOKEN,
      NOW,
    );
    expect(out).toEqual({ invitation: { accepted: true } });
    // personal organization first, then the invitation
    expect(
      createOrganization.createPersonal.mock.invocationCallOrder[0]!,
    ).toBeLessThan(acceptInvitation.acceptAs.mock.invocationCallOrder[0]!);
  });

  it.each([
    ['invalid', new DomainValidationError('invitation-invalid', 'x')],
    ['seat limit', new ConflictError('seat-limit-reached', 'x')],
  ])('%s invite -> accepted:false without throwing', async (_l, error) => {
    acceptInvitation.acceptAs.mockRejectedValue(error);
    const out = await makeHook().onRegistered({ ...ctx, inviteToken: TOKEN });
    expect(out).toEqual({ invitation: { accepted: false } });
    expect(createOrganization.createPersonal).toHaveBeenCalled();
  });

  it('the failed attempt runs in its own nested unit of work, so it is rolled back alone', async () => {
    const runs: string[] = [];
    kit.mocks.uow.run.mockImplementation(
      async (work: () => Promise<unknown>) => {
        runs.push('open');
        try {
          const r = await work();
          runs.push('release');
          return r;
        } catch (e) {
          runs.push('rollback');
          throw e;
        }
      },
    );
    acceptInvitation.acceptAs.mockRejectedValue(
      new DomainValidationError('invitation-invalid', 'x'),
    );
    await makeHook().onRegistered({ ...ctx, inviteToken: TOKEN });
    expect(runs).toContain('rollback');
  });

  it('unexpected errors propagate (the whole registration is undone)', async () => {
    acceptInvitation.acceptAs.mockRejectedValue(new Error('db down'));
    await expect(
      makeHook().onRegistered({ ...ctx, inviteToken: TOKEN }),
    ).rejects.toThrow('db down');
  });

  it('a failure creating the personal organization propagates', async () => {
    createOrganization.createPersonal.mockRejectedValue(new Error('boom'));
    await expect(makeHook().onRegistered(ctx)).rejects.toThrow('boom');
  });
});
