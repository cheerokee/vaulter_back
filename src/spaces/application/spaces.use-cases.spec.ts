import {
  ConflictError,
  DomainValidationError,
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  ADMIN,
  EDITOR,
  KIT_PK,
  MANAGER,
  NOW,
  OLD_KIT_PK,
  ORG_ID,
  OTHER_ORG,
  OUTSIDER,
  READER,
  SPACE_ID,
  STRANGER,
  BAD_WK,
  actor,
  fp,
  makeSpaceKit,
  wk,
} from '../../../test/support/spaces-kit.js';
import { CreateSpaceUseCase } from './create-space.use-case.js';
import { GetSpaceUseCase } from './get-space.use-case.js';
import { ListSpacesUseCase } from './list-spaces.use-case.js';
import { RenameSpaceUseCase } from './rename-space.use-case.js';
import { Space } from '../domain/space.js';

const kit = makeSpaceKit();
const d = kit.deps;
const m = kit.mocks;
const NOT_FOUND = { constructor: NotFoundError, code: 'space-not-found' };

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('CreateSpaceUseCase', () => {
  const useCase = () =>
    new CreateSpaceUseCase(
      d.orgAccess,
      d.recoveryKit,
      d.spaces,
      d.keys,
      d.grants,
      d.roles,
      d.audit,
      d.uow,
    );
  const input = {
    name: ' Financeiro ',
    wrappedKey: wk(1),
    recoveryPublicKey: KIT_PK,
    recoveryWrappedKey: wk(2),
  };

  it('creates the space, version 1 with the org kit fingerprint, the creator copy and the manager role', async () => {
    const view = await useCase().execute(actor(ADMIN), ORG_ID, input);
    expect(view).toMatchObject({
      organizationId: ORG_ID,
      name: 'Financeiro',
      roleKey: 'space_manager',
      currentKeyVersion: 1,
      keyRotationRequired: false,
      recoveryRewrapRequired: false,
      createdAt: NOW,
    });
    const id = view.id;
    expect(m.keys.addVersion).toHaveBeenCalledWith(
      ORG_ID,
      id,
      1,
      wk(2),
      fp(KIT_PK),
    );
    expect(m.grants.upsert).toHaveBeenCalledWith(
      ORG_ID,
      `${id.slice(-3)}-k1`,
      ADMIN,
      wk(1),
    );
    expect(m.roles.assign).toHaveBeenCalledWith(
      ORG_ID,
      id,
      ADMIN,
      'space_manager',
      ADMIN,
    );
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: ADMIN,
        action: 'space.created',
        metadata: { spaceId: id },
      },
    ]);
    expect(kit.trace.every((t) => !t.endsWith('@out'))).toBe(true);
    expect(kit.auditDump()).not.toContain(wk(1));
    expect(kit.auditDump()).not.toContain(wk(2));
  });

  it('needs org.spaces.create: member 403, stranger 404, nothing written', async () => {
    await expect(
      useCase().execute(actor(OUTSIDER), ORG_ID, input),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, input),
    ).rejects.toMatchObject({
      constructor: NotFoundError,
      code: 'organization-not-found',
    });
    expect(m.spaces.create).not.toHaveBeenCalled();
  });

  it('without a kit: 422 recovery-key-required; another kit: 409 recovery-key-changed', async () => {
    kit.orgMembers.get(OTHER_ORG)!.set(ADMIN, 'org_admin');
    await expect(
      useCase().execute(actor(ADMIN), OTHER_ORG, input),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'recovery-key-required',
    });
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, {
        ...input,
        recoveryPublicKey: OLD_KIT_PK,
      }),
    ).rejects.toMatchObject({
      constructor: ConflictError,
      code: 'recovery-key-changed',
    });
    expect(m.spaces.create).not.toHaveBeenCalled();
  });

  it('rejects invalid wrapped keys, recovery key format and names (422) before the unit of work', async () => {
    for (const bad of [
      { ...input, wrappedKey: BAD_WK },
      { ...input, recoveryWrappedKey: 'x' },
      { ...input, recoveryPublicKey: 'x' },
      { ...input, name: '  ' },
    ]) {
      await expect(
        useCase().execute(actor(ADMIN), ORG_ID, bad),
      ).rejects.toBeInstanceOf(DomainValidationError);
    }
    expect(m.uow.run).not.toHaveBeenCalled();
  });
});

describe('ListSpacesUseCase', () => {
  const useCase = () =>
    new ListSpacesUseCase(d.orgAccess, d.recoveryKit, d.spaces);
  const item = (roleKey: string, pendingGrants: number) => ({
    space: kit.spacesById.get(SPACE_ID)!,
    roleKey,
    keyRotationRequired: true,
    recoveryRewrapRequired: true,
    pendingGrants,
  });

  it('mine: passes the current kit fingerprint and shows pendingGrants only to managers', async () => {
    m.spaces.listForMember.mockResolvedValue({
      items: [item('space_manager', 2), item('space_reader', 3)],
      nextCursor: 'c',
    });
    const page = await useCase().execute(actor(MANAGER), ORG_ID, {
      all: false,
      page: { limit: 10 },
    });
    expect(m.spaces.listForMember).toHaveBeenCalledWith(
      ORG_ID,
      MANAGER,
      fp(KIT_PK),
      {
        limit: 10,
      },
    );
    expect(page.nextCursor).toBe('c');
    expect(page.items[0]).toMatchObject({
      id: SPACE_ID,
      roleKey: 'space_manager',
      keyRotationRequired: true,
      recoveryRewrapRequired: true,
      pendingGrants: 2,
    });
    expect(page.items[1]).not.toHaveProperty('pendingGrants');
  });

  it('mine: a stranger gets 404; without a kit the fingerprint is null', async () => {
    await expect(
      useCase().execute(actor(STRANGER), ORG_ID, {
        all: false,
        page: { limit: 10 },
      }),
    ).rejects.toMatchObject({ code: 'organization-not-found' });
    kit.orgMembers.get(OTHER_ORG)!.set(READER, 'org_member');
    m.spaces.listForMember.mockResolvedValue({ items: [], nextCursor: null });
    await useCase().execute(actor(READER), OTHER_ORG, {
      all: false,
      page: { limit: 5 },
    });
    expect(m.spaces.listForMember).toHaveBeenCalledWith(
      OTHER_ORG,
      READER,
      null,
      { limit: 5 },
    );
  });

  it('all: needs org.spaces.create; id, name, memberCount, recoveryRewrapRequired (current kit) and createdAt', async () => {
    m.spaces.listAll.mockResolvedValue({
      items: [
        {
          space: kit.spacesById.get(SPACE_ID)!,
          memberCount: 3,
          recoveryRewrapRequired: true,
        },
      ],
      nextCursor: null,
    });
    const page = await useCase().execute(actor(ADMIN), ORG_ID, {
      all: true,
      page: { limit: 10 },
    });
    expect(page.items).toEqual([
      {
        id: SPACE_ID,
        name: 'Manuais',
        memberCount: 3,
        recoveryRewrapRequired: true,
        createdAt: new Date('2026-10-01T00:00:00Z'),
      },
    ]);
    expect(m.spaces.listAll).toHaveBeenCalledWith(ORG_ID, fp(KIT_PK), {
      limit: 10,
    });
    await expect(
      useCase().execute(actor(MANAGER), ORG_ID, {
        all: true,
        page: { limit: 10 },
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});

describe('GetSpaceUseCase', () => {
  const useCase = () =>
    new GetSpaceUseCase(d.access, d.recoveryKit, d.keys, d.pending);

  it('returns the details with my role and the computed flags', async () => {
    kit.addSpace(SPACE_ID, ORG_ID, [[READER, 'space_reader']], {
      version: 2,
      fingerprints: [fp(OLD_KIT_PK), fp(KIT_PK)],
      rotation: true,
    });
    await expect(useCase().execute(actor(READER), SPACE_ID)).resolves.toEqual({
      id: SPACE_ID,
      organizationId: ORG_ID,
      name: 'Manuais',
      roleKey: 'space_reader',
      currentKeyVersion: 2,
      keyRotationRequired: true,
      recoveryRewrapRequired: true,
      createdAt: new Date('2026-10-01T00:00:00Z'),
      updatedAt: null,
    });
  });

  it('a manager also gets the pending grants count; other roles never do', async () => {
    m.pending.countPending.mockResolvedValue(4);
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID),
    ).resolves.toMatchObject({
      roleKey: 'space_manager',
      pendingGrants: 4,
      keyRotationRequired: false,
      recoveryRewrapRequired: false,
    });
    expect(m.pending.countPending).toHaveBeenCalledWith(ORG_ID, SPACE_ID);
    m.pending.countPending.mockClear();
    const view = await useCase().execute(actor(EDITOR), SPACE_ID);
    expect(view).not.toHaveProperty('pendingGrants');
    expect(m.pending.countPending).not.toHaveBeenCalled();
  });

  it('the org admin outside the space gets 404', async () => {
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('RenameSpaceUseCase', () => {
  const useCase = () =>
    new RenameSpaceUseCase(
      d.access,
      d.recoveryKit,
      d.spaces,
      d.keys,
      d.audit,
      d.uow,
    );

  it('the manager renames under the space lock and it is audited', async () => {
    const view = await useCase().execute(actor(MANAGER), SPACE_ID, {
      name: 'Diretoria',
    });
    expect(view).toMatchObject({ name: 'Diretoria', roleKey: 'space_manager' });
    expect(kit.spacesById.get(SPACE_ID)!.name).toBe('Diretoria');
    expect(kit.trace).toContain('spaces.lockForUpdate');
    expect(kit.audited()).toEqual([
      {
        organizationId: ORG_ID,
        userId: MANAGER,
        action: 'space.renamed',
        metadata: { spaceId: SPACE_ID },
      },
    ]);
  });

  it('returns the post-update updatedAt (read back after the save, as the database set it)', async () => {
    const saved = new Date('2026-10-25T12:34:56Z');
    m.spaces.save.mockImplementationOnce(async (sp: Space) => {
      kit.spacesById.set(
        sp.id,
        Space.restore(
          {
            organizationId: sp.organizationId,
            name: sp.name,
            currentKeyVersion: sp.currentKeyVersion,
            keyRotationRequired: sp.keyRotationRequired,
            createdAt: sp.createdAt,
            updatedAt: saved,
          },
          sp.id,
        ),
      );
    });
    const view = await useCase().execute(actor(MANAGER), SPACE_ID, {
      name: 'Diretoria',
    });
    expect(view.updatedAt).toEqual(saved);
    expect(view.name).toBe('Diretoria');
  });

  it('an editor gets 403, the admin outside the space 404, an invalid name 422', async () => {
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, { name: 'x' }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    await expect(
      useCase().execute(actor(ADMIN), SPACE_ID, { name: 'x' }),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, { name: '' }),
    ).rejects.toMatchObject({ code: 'space-name-invalid' });
    expect(m.spaces.save).not.toHaveBeenCalled();
  });
});
