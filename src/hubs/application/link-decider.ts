import type { OrganizationAccess } from '../../organizations/application/organization-access.js';
import type { HubAccess } from './hub-access.js';

/** Which side(s) of a link the caller decides for. At least one is true, otherwise it threw. */
export type LinkDecider = { isOwner: boolean; isAdmin: boolean };

/**
 * Approve, reject and unlink are for the hub owner and for an admin of the organization (`org.hubs.approve`), and
 * someone can be both. Not the owner: `OrganizationAccess.requirePermission` decides (404 for a non-member of the
 * organization, 403 for a member without the permission). No lock: the use case locks hub -> link afterwards.
 */
export async function resolveLinkDecider(
  access: HubAccess,
  orgAccess: OrganizationAccess,
  hubId: string,
  organizationId: string,
  userId: string,
): Promise<LinkDecider> {
  const grant = await access.find(hubId, userId);
  if (grant?.role === 'hub_owner') {
    return {
      isOwner: true,
      isAdmin: await orgAccess.hasPermission(
        organizationId,
        userId,
        'org.hubs.approve',
      ),
    };
  }
  await orgAccess.requirePermission(organizationId, userId, 'org.hubs.approve');
  return { isOwner: false, isAdmin: true };
}
