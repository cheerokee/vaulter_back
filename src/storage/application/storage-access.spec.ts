import type { HubDirectory } from '../../hubs/application/hub-directory.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { SpaceContentAccess } from '../../spaces/application/space-content-access.js';
import { STORAGE_LOCK_TIMEOUT_MS } from '../domain/backup-limits.js';
import { StorageAccess } from './storage-access.js';

const SPACE = '01900000-0000-7000-8000-000000000002';
const ORG = '01900000-0000-7000-8000-000000000001';

function setup() {
  const trace: string[] = [];
  const content = {
    lockForContent: vi.fn(async () => {
      trace.push('lockForContent');
      return { organizationId: ORG, spaceId: SPACE };
    }),
    requireForContent: vi.fn(async () => {
      trace.push('requireForContent');
      return { organizationId: ORG, spaceId: SPACE };
    }),
  };
  const hubs = { approvedOrganizationIds: vi.fn(async () => [ORG]) };
  const uow = {
    setLockTimeout: vi.fn(async (ms: number) => {
      trace.push(`lockTimeout:${ms}`);
    }),
  };
  const access = new StorageAccess(
    content as unknown as SpaceContentAccess,
    hubs as unknown as HubDirectory,
    uow as unknown as UnitOfWork,
  );
  return { access, trace, uow };
}

describe('StorageAccess', () => {
  it('lock: bounds every lock wait of the transaction (10 s) before locking the space', async () => {
    expect(STORAGE_LOCK_TIMEOUT_MS).toBe(10_000);
    for (const actor of [{ userId: 'u' }, { hubId: 'h' }]) {
      const { access, trace } = setup();
      await access.lock(SPACE, actor, 'memory.write', 'share');
      expect(trace).toEqual(['lockTimeout:10000', 'lockForContent']);
    }
  });

  it('require (reads, no lock): no lock timeout', async () => {
    const { access, uow } = setup();
    await access.require(SPACE, { userId: 'u' }, 'memory.read');
    expect(uow.setLockTimeout).not.toHaveBeenCalled();
  });
});
