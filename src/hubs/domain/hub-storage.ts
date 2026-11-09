import { DomainValidationError } from '../../shared/domain/errors.js';

/** Usable SSD capacity a hub may report (`PUT /hub/storage`): 1 GiB .. 64 TiB. */
export const HUB_STORAGE_CAPACITY_MIN_BYTES = 1_073_741_824;
export const HUB_STORAGE_CAPACITY_MAX_BYTES = 70_368_744_177_664;

/** 422 `hub-storage-capacity-invalid` outside 1 GiB .. 64 TiB or for a non-integer. */
export function assertHubStorageCapacity(bytes: number): number {
  if (
    !Number.isSafeInteger(bytes) ||
    bytes < HUB_STORAGE_CAPACITY_MIN_BYTES ||
    bytes > HUB_STORAGE_CAPACITY_MAX_BYTES
  ) {
    throw new DomainValidationError(
      'hub-storage-capacity-invalid',
      'The capacity must be a whole number of bytes between 1 GiB and 64 TiB.',
    );
  }
  return bytes;
}

/** The capacity the hub reported (null = never: no check) and the sum of the spaces installed on it. */
export type HubStorageState = {
  capacityBytes: number | null;
  reservedBytes: number;
};

/**
 * Installing (or growing) `extraBytes` more must keep the installed spaces within the capacity: 422
 * `hub-storage-full` with `missingBytes` (and `hubId` when given: a resize can hit any of several hubs). A capacity
 * below what is already reserved (SSD swapped) only refuses what comes next.
 */
export function assertHubCapacityFits(
  state: HubStorageState,
  extraBytes: number,
  hubId?: string,
): void {
  if (state.capacityBytes === null) return;
  const missingBytes = state.reservedBytes + extraBytes - state.capacityBytes;
  if (missingBytes <= 0) return;
  throw new DomainValidationError(
    'hub-storage-full',
    'The hub does not have room for this space.',
    hubId ? { hubId, missingBytes } : { missingBytes },
  );
}
