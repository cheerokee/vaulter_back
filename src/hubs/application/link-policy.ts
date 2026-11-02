import type { OrganizationDirectory } from '../../organizations/application/organization-directory.js';
import type { HubLinkPolicy } from '../domain/hub-organization-link.js';

/**
 * The organization's CURRENT hub link policy, read by every link decision (a policy change is honored by the next
 * approval, spec §6). Callers already checked the organization exists, so a missing one is a data defect.
 */
export async function currentLinkPolicy(
  directory: OrganizationDirectory,
  organizationId: string,
): Promise<HubLinkPolicy> {
  const policy = await directory.hubLinkPolicy(organizationId);
  if (!policy) {
    throw new Error(`Organization ${organizationId} has no hub link policy.`);
  }
  return policy;
}
