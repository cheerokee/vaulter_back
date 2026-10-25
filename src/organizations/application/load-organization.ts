import { NotFoundError } from '../../shared/domain/errors.js';
import type { Organization } from '../domain/organization.js';
import type { OrganizationRepository } from '../domain/organization.repository.js';

/** Loads an organization the caller already proved access to; missing reads as not found (404). */
export async function loadOrganization(
  orgs: OrganizationRepository,
  orgId: string,
): Promise<Organization> {
  const org = await orgs.findById(orgId);
  if (!org) {
    throw new NotFoundError(
      'organization-not-found',
      'The organization was not found.',
    );
  }
  return org;
}
