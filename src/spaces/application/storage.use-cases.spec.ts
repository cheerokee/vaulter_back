import {
  ADMIN,
  EDITOR,
  KIT_PK,
  MANAGER,
  NOW,
  ORG_ID,
  SPACE_ID,
  actor,
  makeSpaceKit,
  wk,
} from '../../../test/support/spaces-kit.js';
import type { SpaceQuotaHooks } from '../../shared/application/space-quota-hooks.js';
import {
  DomainValidationError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import { CreateSpaceUseCase } from './create-space.use-case.js';
import { GetSpaceUseCase } from './get-space.use-case.js';
import { ResizeSpaceStorageUseCase } from './resize-space-storage.use-case.js';
import { SpaceStorageUsage } from './space-storage-usage.js';

const GiB = 1024 ** 3;
const kit = makeSpaceKit();
const d = kit.deps;
const m = kit.mocks;

const usage = new SpaceStorageUsage();
const hooks = {
  lock: vi.fn(async () => {
    kit.trace.push('hooks.lock');
  }),
  assertIncrease: vi.fn(async () => {
    kit.trace.push('hooks.assertIncrease');
  }),
};

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
  usage.release();
  hooks.lock.mockImplementation(async () => {
    kit.trace.push('hooks.lock');
  });
  hooks.assertIncrease.mockImplementation(async () => {
    kit.trace.push('hooks.assertIncrease');
  });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe('SpaceStorageUsage (provisional port, bound by storage later)', () => {
  it('reads 0 until a source is provided; one source at a time', async () => {
    const fresh = new SpaceStorageUsage();
    await expect(fresh.usedBytes(ORG_ID, SPACE_ID)).resolves.toBe(0);
    const source = { usedBytes: vi.fn(async () => 7) };
    fresh.use(source);
    await expect(fresh.usedBytes(ORG_ID, SPACE_ID)).resolves.toBe(7);
    expect(source.usedBytes).toHaveBeenCalledWith(ORG_ID, SPACE_ID);
    expect(() => fresh.use({ usedBytes: async () => 1 })).toThrow();
    fresh.release();
    await expect(fresh.usedBytes(ORG_ID, SPACE_ID)).resolves.toBe(0);
  });

  it('replace (test seam) swaps the bound source and the restore function puts the previous one back', async () => {
    const fresh = new SpaceStorageUsage();
    fresh.use({ usedBytes: async () => 7 });
    const restore = fresh.replace({ usedBytes: async () => 42 });
    await expect(fresh.usedBytes(ORG_ID, SPACE_ID)).resolves.toBe(42);
    restore();
    await expect(fresh.usedBytes(ORG_ID, SPACE_ID)).resolves.toBe(7);
  });
});

describe('CreateSpaceUseCase storage', () => {
  const useCase = () =>
    new CreateSpaceUseCase(
      d.orgAccess,
      d.recoveryKit,
      d.directory,
      d.spaces,
      d.keys,
      d.grants,
      d.roles,
      d.audit,
      d.uow,
    );
  const input = {
    name: 'Financeiro',
    wrappedKey: wk(1),
    recoveryPublicKey: KIT_PK,
    recoveryWrappedKey: wk(2),
  };

  it('is born with 10 GiB under the locked organization quota, before the insert', async () => {
    const view = await useCase().execute(actor(ADMIN), ORG_ID, input);
    expect(view.storage).toEqual({ quotaBytes: 10 * GiB, usedBytes: 0 });
    expect(m.directory.lockStorageQuota).toHaveBeenCalledWith(ORG_ID);
    const t = kit.trace;
    expect(t.indexOf('directory.lockStorageQuota')).toBeGreaterThan(-1);
    expect(t.indexOf('directory.lockStorageQuota')).toBeLessThan(
      t.indexOf('spaces.create'),
    );
    expect(t).not.toContain('directory.lockStorageQuota@out');
  });

  it('takes a chosen size and refuses beyond the quota with what is available', async () => {
    kit.storageQuota.set(ORG_ID, {
      quotaBytes: 50 * GiB,
      reservedBytes: 45 * GiB,
    });
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, {
        ...input,
        storageQuotaBytes: 5 * GiB + 1,
      }),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'organization-storage-quota-exceeded',
      details: { availableBytes: 5 * GiB },
    });
    expect(m.spaces.create).not.toHaveBeenCalled();
    const view = await useCase().execute(actor(ADMIN), ORG_ID, {
      ...input,
      storageQuotaBytes: 5 * GiB,
    });
    expect(view.storage?.quotaBytes).toBe(5 * GiB);
  });

  it('an invalid size is 422 before any query', async () => {
    await expect(
      useCase().execute(actor(ADMIN), ORG_ID, {
        ...input,
        storageQuotaBytes: GiB - 1,
      }),
    ).rejects.toMatchObject({ code: 'space-storage-quota-invalid' });
    expect(m.uow.run).not.toHaveBeenCalled();
  });
});

describe('ResizeSpaceStorageUseCase', () => {
  const useCase = () =>
    new ResizeSpaceStorageUseCase(
      d.access,
      d.recoveryKit,
      d.spaces,
      d.keys,
      d.directory,
      usage,
      hooks as unknown as SpaceQuotaHooks,
      d.audit,
      d.uow,
    );

  it('an increase: hubs locked before the space, then the org quota, then the hub capacities; saved and audited', async () => {
    const view = await useCase().execute(actor(MANAGER), SPACE_ID, {
      storageQuotaBytes: 20 * GiB,
    });
    expect(view.storage).toEqual({ quotaBytes: 20 * GiB, usedBytes: 0 });
    const t = kit.trace;
    const at = (name: string) => t.indexOf(name);
    expect(at('hooks.lock')).toBeLessThan(at('spaces.lockForUpdate'));
    expect(at('spaces.lockForUpdate')).toBeLessThan(
      at('directory.lockStorageQuota'),
    );
    expect(at('directory.lockStorageQuota')).toBeLessThan(
      at('hooks.assertIncrease'),
    );
    expect(at('hooks.assertIncrease')).toBeLessThan(at('spaces.save'));
    expect(hooks.lock).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      spaceId: SPACE_ID,
    });
    expect(hooks.assertIncrease).toHaveBeenCalledWith({
      organizationId: ORG_ID,
      spaceId: SPACE_ID,
      fromBytes: 10 * GiB,
      toBytes: 20 * GiB,
    });
    expect(kit.spacesById.get(SPACE_ID)!.storageQuotaBytes).toBe(20 * GiB);
    expect(kit.audited()).toContainEqual({
      organizationId: ORG_ID,
      userId: MANAGER,
      action: 'space.storage_quota_changed',
      metadata: { spaceId: SPACE_ID, fromBytes: 10 * GiB, toBytes: 20 * GiB },
    });
  });

  it('an increase beyond the organization quota is 422 and nothing is saved', async () => {
    kit.storageQuota.set(ORG_ID, {
      quotaBytes: 50 * GiB,
      reservedBytes: 45 * GiB,
    });
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, {
        storageQuotaBytes: 16 * GiB,
      }),
    ).rejects.toMatchObject({
      code: 'organization-storage-quota-exceeded',
      details: { availableBytes: 5 * GiB },
    });
    expect(hooks.assertIncrease).not.toHaveBeenCalled();
    expect(m.spaces.save).not.toHaveBeenCalled();
  });

  it('a refusal from a hub hook is passed through and nothing is saved', async () => {
    hooks.assertIncrease.mockRejectedValueOnce(
      new DomainValidationError('hub-storage-full', 'x', {
        hubId: 'h',
        missingBytes: 1,
      }),
    );
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, {
        storageQuotaBytes: 11 * GiB,
      }),
    ).rejects.toMatchObject({ code: 'hub-storage-full' });
    expect(m.spaces.save).not.toHaveBeenCalled();
  });

  it('a decrease checks only the usage (no quota, no hub capacity)', async () => {
    usage.use({ usedBytes: async () => 3 * GiB });
    await expect(
      useCase().execute(actor(MANAGER), SPACE_ID, {
        storageQuotaBytes: 2 * GiB,
      }),
    ).rejects.toMatchObject({
      code: 'space-storage-quota-below-usage',
      details: { usedBytes: 3 * GiB },
    });
    const view = await useCase().execute(actor(MANAGER), SPACE_ID, {
      storageQuotaBytes: 3 * GiB,
    });
    expect(view.storage).toEqual({ quotaBytes: 3 * GiB, usedBytes: 3 * GiB });
    expect(m.directory.lockStorageQuota).not.toHaveBeenCalled();
    expect(hooks.assertIncrease).not.toHaveBeenCalled();
  });

  it('only a manager resizes (403 for an editor)', async () => {
    await expect(
      useCase().execute(actor(EDITOR), SPACE_ID, {
        storageQuotaBytes: 20 * GiB,
      }),
    ).rejects.toBeInstanceOf(PermissionDeniedError);
    expect(m.spaces.save).not.toHaveBeenCalled();
  });
});

describe('GetSpaceUseCase storage', () => {
  it('every member sees the size and the usage', async () => {
    usage.use({ usedBytes: async () => 123 });
    const view = await new GetSpaceUseCase(
      d.access,
      d.recoveryKit,
      d.keys,
      d.pending,
      d.room,
      usage,
    ).execute(actor(EDITOR), SPACE_ID);
    expect(view.storage).toEqual({ quotaBytes: 10 * GiB, usedBytes: 123 });
  });
});
