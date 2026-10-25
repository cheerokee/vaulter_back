import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { Organization } from './organization.js';
import type { OrgRoleKey } from './membership.js';

export type OrganizationWithRole = {
  organization: Organization;
  roleKey: OrgRoleKey;
};

export abstract class OrganizationRepository {
  abstract create(organization: Organization): Promise<void>;
  abstract save(organization: Organization): Promise<void>;
  abstract findById(orgId: string): Promise<Organization | null>;
  abstract listForUser(
    userId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<OrganizationWithRole>>;
}
