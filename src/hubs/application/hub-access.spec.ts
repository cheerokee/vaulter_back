import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import type { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { HubRoleRepository } from '../domain/hub-role.repository.js';
import { Hub } from '../domain/hub.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { HubAccess } from './hub-access.js';

const HUB_ID = '019a0000-0000-7000-8000-0000000000aa';
const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const MEMBER = '019a0000-0000-7000-8000-0000000000b1';

const hub = (deletedAt: Date | null = null) =>
  Hub.restore(
    {
      ownerUserId: OWNER,
      name: 'Sala',
      signingPublicKey: 's',
      encryptionPublicKey: 'e',
      lastSeenAt: null,
      deletedAt,
    },
    HUB_ID,
  );

const hubs = { findById: vi.fn() };
const roles = { roleOf: vi.fn() };
const contexts: unknown[] = [];
const uow = {
  withContext: vi.fn(async (ctx: unknown, work: () => Promise<unknown>) => {
    contexts.push(ctx);
    return work();
  }),
};
const access = () =>
  new HubAccess(
    hubs as unknown as HubRepository,
    roles as unknown as HubRoleRepository,
    uow as unknown as UnitOfWork,
  );

beforeEach(() => {
  vi.clearAllMocks();
  contexts.length = 0;
  hubs.findById.mockResolvedValue(hub());
  roles.roleOf.mockResolvedValue(null);
});

describe('HubAccess', () => {
  it('reads the hub in the caller context: the owner is hub_owner', async () => {
    await expect(access().find(HUB_ID, OWNER)).resolves.toMatchObject({
      role: 'hub_owner',
    });
    expect(contexts).toEqual([{ userId: OWNER }]);
    expect(roles.roleOf).not.toHaveBeenCalled();
  });

  it('an explicit role wins; a linked member without one is an implicit hub_user', async () => {
    roles.roleOf.mockResolvedValueOnce('hub_operator');
    expect((await access().find(HUB_ID, MEMBER))?.role).toBe('hub_operator');
    expect((await access().find(HUB_ID, MEMBER))?.role).toBe('hub_user');
  });

  it('gives the same 404 for an invisible, deregistered, missing hub or a malformed id (no query for the latter)', async () => {
    const notFound = { constructor: NotFoundError, code: 'hub-not-found' };
    hubs.findById.mockResolvedValueOnce(null);
    await expect(access().requireAccess(HUB_ID, MEMBER)).rejects.toMatchObject(
      notFound,
    );
    hubs.findById.mockResolvedValueOnce(hub(new Date()));
    await expect(access().requireAccess(HUB_ID, OWNER)).rejects.toMatchObject(
      notFound,
    );
    hubs.findById.mockClear();
    await expect(access().requireAccess('nope', OWNER)).rejects.toMatchObject(
      notFound,
    );
    expect(hubs.findById).not.toHaveBeenCalled();
  });

  it('requireOwner: 403 for someone who sees the hub, 404 for whoever does not', async () => {
    await expect(access().requireOwner(HUB_ID, OWNER)).resolves.toMatchObject({
      id: HUB_ID,
    });
    await expect(access().requireOwner(HUB_ID, MEMBER)).rejects.toMatchObject({
      constructor: PermissionDeniedError,
      code: 'permission-denied',
    });
    hubs.findById.mockResolvedValueOnce(null);
    await expect(access().requireOwner(HUB_ID, MEMBER)).rejects.toMatchObject({
      code: 'hub-not-found',
    });
  });
});
