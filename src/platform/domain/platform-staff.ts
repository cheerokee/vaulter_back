import { DomainValidationError } from '../../shared/domain/errors.js';
import type { PlatformRoleKey } from './platform-catalog.js';

/**
 * The platform never stays without an administrator: taking `platform_admin` from the last live admin is refused.
 * `lockedAdmins` must come from PlatformRoleRepository.lockAdmins (under the lock, so two concurrent revocations
 * of the only two admins serialize and the second one sees a single admin left).
 */
export function assertNotLastPlatformAdmin(
  roleKey: PlatformRoleKey,
  targetUserId: string,
  lockedAdmins: readonly string[],
): void {
  if (
    roleKey === 'platform_admin' &&
    lockedAdmins.length === 1 &&
    lockedAdmins[0] === targetUserId
  ) {
    throw new DomainValidationError(
      'last-platform-admin',
      'The last platform administrator cannot lose the role.',
    );
  }
}
