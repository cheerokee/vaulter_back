import {
  NotFoundError,
  PermissionDeniedError,
} from '../../shared/domain/errors.js';
import {
  EDITOR,
  MANAGER,
  ORG_ID,
  OTHER_ORG,
  OTHER_SPACE,
  OUTSIDER,
  READER,
  SPACE_ID,
  makeSpaceKit,
} from '../../../test/support/spaces-kit.js';
import { SpaceContentAccess } from './space-content-access.js';

const kit = makeSpaceKit();
const m = kit.mocks;
const content = new SpaceContentAccess(
  kit.deps.access,
  kit.deps.spaces,
  kit.deps.room,
);
const HUB = '01900000-0000-7000-8000-0000000000b1';
const NOT_FOUND = { constructor: NotFoundError, code: 'space-not-found' };
const DENIED = {
  constructor: PermissionDeniedError,
  code: 'permission-denied',
};

beforeEach(() => {
  vi.resetAllMocks();
  kit.reset();
});

describe('SpaceContentAccess.lockForContent (user)', () => {
  it('locks the space of a member with the permission and returns its storage state', async () => {
    const state = await content.lockForContent(
      SPACE_ID,
      { kind: 'user', userId: EDITOR },
      'memory.write',
    );
    expect(state).toEqual({
      organizationId: ORG_ID,
      spaceId: SPACE_ID,
      currentKeyVersion: 1,
      keyRotationRequired: false,
      storageQuotaBytes: 10_737_418_240,
    });
    expect(kit.trace.some((t) => t.startsWith('spaces.lockForUpdate'))).toBe(
      true,
    );
  });

  it('403 for a member without the permission; 404 for a non-member', async () => {
    await expect(
      content.lockForContent(
        SPACE_ID,
        { kind: 'user', userId: READER },
        'memory.write',
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      content.lockForContent(
        SPACE_ID,
        { kind: 'user', userId: EDITOR },
        'memory.delete',
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      content.lockForContent(
        SPACE_ID,
        { kind: 'user', userId: OUTSIDER },
        'memory.write',
      ),
    ).rejects.toMatchObject(NOT_FOUND);
  });
});

describe('SpaceContentAccess.lockForContent (hub)', () => {
  const hub = (organizationIds: string[] = [OTHER_ORG, ORG_ID]) => ({
    kind: 'hub' as const,
    hubId: HUB,
    organizationIds,
  });

  it('an editor Room writes: finds the organization among the linked ones and locks the space', async () => {
    kit.roomBySpace.get(SPACE_ID)!.set(HUB, 'space_editor');
    const state = await content.lockForContent(SPACE_ID, hub(), 'memory.write');
    expect(state.organizationId).toBe(ORG_ID);
    expect(kit.trace.some((t) => t.startsWith('spaces.lockForUpdate'))).toBe(
      true,
    );
  });

  it('404 (never 403) for a reader Room, a missing Room, delete, an unlinked organization or a malformed id', async () => {
    kit.roomBySpace.get(SPACE_ID)!.set(HUB, 'space_reader');
    await expect(
      content.lockForContent(SPACE_ID, hub(), 'memory.write'),
    ).rejects.toMatchObject(NOT_FOUND);
    kit.roomBySpace.get(SPACE_ID)!.set(HUB, 'space_editor');
    await expect(
      content.lockForContent(SPACE_ID, hub(), 'memory.delete'),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      content.lockForContent(SPACE_ID, hub([OTHER_ORG]), 'memory.write'),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      content.lockForContent(OTHER_SPACE, hub(), 'memory.write'),
    ).rejects.toMatchObject(NOT_FOUND);
    await expect(
      content.lockForContent('nope', hub(), 'memory.write'),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('re-reads the Room under the lock: a Room revoked before the lock is 404', async () => {
    kit.roomBySpace.get(SPACE_ID)!.set(HUB, 'space_editor');
    m.spaces.lockForUpdate.mockImplementationOnce(async (orgId: string) => {
      kit.roomBySpace.get(SPACE_ID)!.delete(HUB);
      return kit.spacesById.get(SPACE_ID) && orgId === ORG_ID
        ? kit.spacesById.get(SPACE_ID)!
        : null;
    });
    await expect(
      content.lockForContent(SPACE_ID, hub(), 'memory.write'),
    ).rejects.toMatchObject(NOT_FOUND);
  });

  it('the manager also writes as a person', async () => {
    await expect(
      content.lockForContent(
        SPACE_ID,
        { kind: 'user', userId: MANAGER },
        'memory.delete',
      ),
    ).resolves.toMatchObject({ spaceId: SPACE_ID });
  });
});
