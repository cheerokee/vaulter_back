import { NotFoundError } from '../../shared/domain/errors.js';
import type { Organization } from '../domain/organization.js';
import type { OrganizationRepository } from '../domain/organization.repository.js';

/** Loads an organization the caller already proved access to; missing reads as not found (404). */
export async function loadOrganization(
  orgs: OrganizationRepository,
  orgId: string,
): Promise<Organization> {
  return orFound(await orgs.findById(orgId));
}

/** Same, with the row locked until the end of the unit of work (read-modify-write of the organization row). */
export async function lockOrganization(
  orgs: OrganizationRepository,
  orgId: string,
): Promise<Organization> {
  return orFound(await orgs.lockForUpdate(orgId));
}

function orFound(org: Organization | null): Organization {
  if (!org) {
    throw new NotFoundError(
      'organization-not-found',
      'The organization was not found.',
    );
  }
  return org;
}
