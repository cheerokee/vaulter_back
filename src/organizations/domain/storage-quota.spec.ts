import { DomainValidationError } from '../../shared/domain/errors.js';
import { Organization } from './organization.js';
import {
  ORGANIZATION_STORAGE_QUOTA_DEFAULT_BYTES,
  assertStorageQuotaFits,
} from './storage-quota.js';

const GiB = 1024 ** 3;
const now = new Date('2026-11-09T00:00:00Z');

describe('organization storage quota', () => {
  it('defaults to 50 GiB for regular and personal organizations', () => {
    expect(ORGANIZATION_STORAGE_QUOTA_DEFAULT_BYTES).toBe(53_687_091_200);
    expect(Organization.create({ name: 'Acme', now }).storageQuotaBytes).toBe(
      53_687_091_200,
    );
    expect(
      Organization.createPersonal({ name: 'Ana', ownerId: 'u', now })
        .storageQuotaBytes,
    ).toBe(53_687_091_200);
  });

  it('accepts a reservation that fits exactly', () => {
    expect(() =>
      assertStorageQuotaFits(
        { quotaBytes: 50 * GiB, reservedBytes: 45 * GiB },
        5 * GiB,
      ),
    ).not.toThrow();
  });

  it('refuses beyond the quota with what is still available', () => {
    expect(() =>
      assertStorageQuotaFits(
        { quotaBytes: 50 * GiB, reservedBytes: 45 * GiB },
        5 * GiB + 1,
      ),
    ).toThrow(
      expect.objectContaining({
        constructor: DomainValidationError,
        code: 'organization-storage-quota-exceeded',
        details: { availableBytes: 5 * GiB },
      }),
    );
  });

  it('an organization already above its quota has 0 available (nothing is blocked, it just cannot reserve more)', () => {
    expect(() =>
      assertStorageQuotaFits(
        { quotaBytes: 50 * GiB, reservedBytes: 60 * GiB },
        1,
      ),
    ).toThrow(expect.objectContaining({ details: { availableBytes: 0 } }));
  });
});
