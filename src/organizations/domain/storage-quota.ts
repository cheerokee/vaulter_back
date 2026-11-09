import { DomainValidationError } from '../../shared/domain/errors.js';

/** Cloud quota of a new organization (50 GiB, personal or not; spec storage-backup §4.4). */
export const ORGANIZATION_STORAGE_QUOTA_DEFAULT_BYTES = 53_687_091_200;

/** The organization quota and the sum of the reserved sizes of its live spaces. */
export type OrganizationStorageQuota = {
  quotaBytes: number;
  reservedBytes: number;
};

/**
 * Reserving `extraBytes` more must keep the reserved sum within the quota: 422 `organization-storage-quota-exceeded`
 * with `availableBytes` (0 for an organization already above its quota: it only cannot reserve more).
 */
export function assertStorageQuotaFits(
  quota: OrganizationStorageQuota,
  extraBytes: number,
): void {
  if (quota.reservedBytes + extraBytes <= quota.quotaBytes) return;
  throw new DomainValidationError(
    'organization-storage-quota-exceeded',
    'The organization storage quota does not have room for this size.',
    { availableBytes: Math.max(0, quota.quotaBytes - quota.reservedBytes) },
  );
}
