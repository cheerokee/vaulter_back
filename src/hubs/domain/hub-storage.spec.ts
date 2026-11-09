import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  HUB_STORAGE_CAPACITY_MAX_BYTES,
  HUB_STORAGE_CAPACITY_MIN_BYTES,
  assertHubCapacityFits,
  assertHubStorageCapacity,
} from './hub-storage.js';

const GiB = 1024 ** 3;
const HUB = '019a0000-0000-7000-8000-0000000000aa';

describe('hub storage capacity', () => {
  it('accepts 1 GiB to 64 TiB', () => {
    expect(HUB_STORAGE_CAPACITY_MIN_BYTES).toBe(GiB);
    expect(HUB_STORAGE_CAPACITY_MAX_BYTES).toBe(64 * 1024 ** 4);
    expect(assertHubStorageCapacity(GiB)).toBe(GiB);
    expect(assertHubStorageCapacity(64 * 1024 ** 4)).toBe(64 * 1024 ** 4);
  });

  it.each([0, GiB - 1, 64 * 1024 ** 4 + 1, 2.5, Number.NaN])(
    'rejects capacity %d',
    (bytes) => {
      expect(() => assertHubStorageCapacity(bytes)).toThrow(
        expect.objectContaining({
          constructor: DomainValidationError,
          code: 'hub-storage-capacity-invalid',
        }),
      );
    },
  );

  it('a hub that never reported its capacity is not checked', () => {
    expect(() =>
      assertHubCapacityFits(
        { capacityBytes: null, reservedBytes: 999 * GiB },
        999 * GiB,
        { showBytes: true },
      ),
    ).not.toThrow();
  });

  it('fits exactly; one byte more is 422 with what is missing', () => {
    const state = { capacityBytes: 20 * GiB, reservedBytes: 10 * GiB };
    expect(() =>
      assertHubCapacityFits(state, 10 * GiB, { showBytes: true }),
    ).not.toThrow();
    expect(() =>
      assertHubCapacityFits(state, 10 * GiB + 1, { showBytes: true }),
    ).toThrow(
      expect.objectContaining({
        constructor: DomainValidationError,
        code: 'hub-storage-full',
        details: { missingBytes: 1 },
      }),
    );
  });

  it('names the hub when asked (resizing a space installed on several hubs)', () => {
    expect(() =>
      assertHubCapacityFits(
        { capacityBytes: 10 * GiB, reservedBytes: 15 * GiB },
        5 * GiB,
        { hubId: HUB, showBytes: true },
      ),
    ).toThrow(
      expect.objectContaining({
        details: { hubId: HUB, missingBytes: 10 * GiB },
      }),
    );
  });

  // The reserved sum covers every organization on the hub: only its owner may see byte figures derived from it.
  it('without showBytes (caller is not the hub owner) the error carries no byte figures, only the hub', () => {
    const state = { capacityBytes: 10 * GiB, reservedBytes: 15 * GiB };
    expect(() =>
      assertHubCapacityFits(state, 5 * GiB, { hubId: HUB, showBytes: false }),
    ).toThrow(
      expect.objectContaining({
        code: 'hub-storage-full',
        details: { hubId: HUB },
      }),
    );
    let thrown: unknown;
    try {
      assertHubCapacityFits(state, 5 * GiB, { showBytes: false });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ code: 'hub-storage-full' });
    expect((thrown as DomainValidationError).details).toBeUndefined();
  });
});
