import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';

/**
 * Where hub actions without an organization are audited (`hub.claimed`, `hub.deregistered`, `hub.role.changed`):
 * the owner's personal organization (plan decision 11). Every user gets one at registration.
 */
export async function ownerAuditOrganization(
  directory: OrganizationDirectory,
  ownerUserId: string,
): Promise<string> {
  const orgId = await directory.personalOrganizationIdOf(ownerUserId);
  if (!orgId) {
    throw new Error(`User ${ownerUserId} has no personal organization.`);
  }
  return orgId;
}
