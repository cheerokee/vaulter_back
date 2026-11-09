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
  /**
   * Reads the organization row locked (`FOR NO KEY UPDATE`: children inserts, whose FK takes `FOR KEY SHARE`, are
   * not blocked) until the end of the unit of work. Every read-modify-write of the row goes through it, so a
   * concurrent writer never saves stale fields over another one (e.g. the kit over the protection window).
   * MUST run inside `UnitOfWork.run`.
   */
  abstract lockForUpdate(orgId: string): Promise<Organization | null>;
  /**
   * Sum of the reserved sizes (`spaces.storage_quota_bytes`) of the organization's live spaces, in its RLS scope.
   * Consistent with a quota check only under `lockForUpdate`: creating or growing a space takes that lock first.
   */
  abstract reservedStorageBytes(orgId: string): Promise<number>;
  /** The user's personal organization (they are its owner), or null. */
  abstract findPersonalOf(userId: string): Promise<Organization | null>;
  abstract listForUser(
    userId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<OrganizationWithRole>>;
}
