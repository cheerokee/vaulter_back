import { DomainValidationError } from '../../shared/domain/errors.js';
import type { SpaceQuotaHooks } from '../../shared/application/space-quota-hooks.js';
import { Hub } from '../domain/hub.js';
import type { HubSpaceRepository } from '../domain/hub-space.repository.js';
import type { HubRepository } from '../domain/hub.repository.js';
import { HubsSpaceQuotaHook } from './space-quota.hook.js';

const GiB = 1024 ** 3;
const ORG = '019a0000-0000-7000-8000-0000000000c1';
const SPACE = '019a0000-0000-7000-8000-0000000005a1';
const HUB_ID = '019a0000-0000-7000-8000-0000000000aa';
const OWNER = '019a0000-0000-7000-8000-0000000000a1';
const GESTOR = '019a0000-0000-7000-8000-0000000000a2';

const hub = (capacityBytes: number | null) =>
  Hub.restore(
    {
      ownerUserId: OWNER,
      name: 'Sala',
      signingPublicKey: 's',
      encryptionPublicKey: 'e',
      lastSeenAt: null,
      deletedAt: null,
      storageCapacityBytes: capacityBytes,
    },
    HUB_ID,
  );

function setup(capacityBytes: number | null, reservedBytes: number) {
  const hubs = {
    lockForStorage: vi.fn(async () => hub(capacityBytes)),
  };
  const hubSpaces = {
    hubIdsOfSpace: vi.fn(async () => [HUB_ID]),
    reservedBytes: vi.fn(async () => reservedBytes),
  };
  return new HubsSpaceQuotaHook(
    {} as SpaceQuotaHooks,
    hubs as unknown as HubRepository,
    hubSpaces as unknown as HubSpaceRepository,
  );
}

describe('HubsSpaceQuotaHook.assertIncrease', () => {
  const grow = (actorUserId: string) => ({
    organizationId: ORG,
    spaceId: SPACE,
    actorUserId,
    fromBytes: 10 * GiB,
    toBytes: 15 * GiB,
  });

  it('the hub owner gets the hub and the missing bytes', async () => {
    await expect(
      setup(20 * GiB, 18 * GiB).assertIncrease(grow(OWNER)),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'hub-storage-full',
      details: { hubId: HUB_ID, missingBytes: 3 * GiB },
    });
  });

  // The reserved sum covers every organization on the hub: a Gestor who is not the owner sees only the hub id.
  it('anyone else gets only the hub, no byte figures', async () => {
    await expect(
      setup(20 * GiB, 18 * GiB).assertIncrease(grow(GESTOR)),
    ).rejects.toMatchObject({
      constructor: DomainValidationError,
      code: 'hub-storage-full',
      details: { hubId: HUB_ID },
    });
    const error: unknown = await setup(20 * GiB, 18 * GiB)
      .assertIncrease(grow(GESTOR))
      .catch((e: unknown) => e);
    expect((error as DomainValidationError).details).not.toHaveProperty(
      'missingBytes',
    );
  });

  it('fits: nothing thrown', async () => {
    await expect(
      setup(20 * GiB, 15 * GiB).assertIncrease(grow(GESTOR)),
    ).resolves.toBeUndefined();
  });
});
