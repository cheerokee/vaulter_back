import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  SPACE_STORAGE_QUOTA_DEFAULT_BYTES,
  SPACE_STORAGE_QUOTA_MAX_BYTES,
  SPACE_STORAGE_QUOTA_MIN_BYTES,
  Space,
} from './space.js';

const GiB = 1024 ** 3;
const now = new Date('2026-11-09T00:00:00Z');
const make = (storageQuotaBytes?: number) =>
  Space.create({
    organizationId: 'org',
    name: 'Casa',
    now,
    ...(storageQuotaBytes !== undefined ? { storageQuotaBytes } : {}),
  });

describe('Space storage quota', () => {
  it('uses the spec values: 10 GiB by default, 1 GiB to 5 TiB', () => {
    expect(SPACE_STORAGE_QUOTA_DEFAULT_BYTES).toBe(10_737_418_240);
    expect(SPACE_STORAGE_QUOTA_MIN_BYTES).toBe(GiB);
    expect(SPACE_STORAGE_QUOTA_MAX_BYTES).toBe(5 * 1024 ** 4);
  });

  it('is born with the default or the chosen size', () => {
    expect(make().storageQuotaBytes).toBe(10_737_418_240);
    expect(make(2 * GiB).storageQuotaBytes).toBe(2 * GiB);
    expect(make(GiB).storageQuotaBytes).toBe(GiB);
    expect(make(5 * 1024 ** 4).storageQuotaBytes).toBe(5 * 1024 ** 4);
  });

  it.each([0, -1, GiB - 1, 5 * 1024 ** 4 + 1, 1.5 * GiB + 0.5, Number.NaN])(
    'rejects size %d',
    (bytes) => {
      expect(() => make(bytes)).toThrow(
        expect.objectContaining({
          constructor: DomainValidationError,
          code: 'space-storage-quota-invalid',
        }),
      );
      expect(() => make().resizeStorage(bytes, 0)).toThrow(
        DomainValidationError,
      );
    },
  );

  it('resizes up or down and reports from/to', () => {
    const s = make();
    expect(s.resizeStorage(20 * GiB, 0)).toEqual({
      fromBytes: 10 * GiB,
      toBytes: 20 * GiB,
    });
    expect(s.storageQuotaBytes).toBe(20 * GiB);
    expect(s.resizeStorage(3 * GiB, 3 * GiB)).toEqual({
      fromBytes: 20 * GiB,
      toBytes: 3 * GiB,
    });
  });

  it('never shrinks below the usage (trash included): 422 with the usage', () => {
    const s = make();
    expect(() => s.resizeStorage(2 * GiB, 2 * GiB + 1)).toThrow(
      expect.objectContaining({
        constructor: DomainValidationError,
        code: 'space-storage-quota-below-usage',
        details: { usedBytes: 2 * GiB + 1 },
      }),
    );
    expect(s.storageQuotaBytes).toBe(10 * GiB);
  });
});
