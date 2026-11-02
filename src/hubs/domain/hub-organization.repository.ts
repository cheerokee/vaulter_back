import type { KeysetSlice } from '../../shared/domain/pagination.js';
import type { HubOrganizationLink } from './hub-organization-link.js';

export abstract class HubOrganizationRepository {
  abstract find(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null>;
  /**
   * Insert, or update the existing (hub, organization) row, reviving a tombstone. Takes the hub row FOR SHARE first
   * (lock order: hub -> link -> space) and refuses a missing or deregistered hub (`hub-not-found`).
   */
  abstract upsert(link: HubOrganizationLink): Promise<void>;
  /** Live links of the hub, by organization id; `slice` = only ids after `after`, at most `limit`. */
  abstract list(
    hubId: string,
    slice?: KeysetSlice,
  ): Promise<HubOrganizationLink[]>;
  /** Organizations with an approved link. */
  abstract listActiveOrgIds(hubId: string): Promise<string[]>;
  /** SELECT ... FOR UPDATE on the (hub, organization) row. REQUIRES an active unit of work. */
  abstract lockForUpdate(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null>;
  /**
   * SELECT ... FOR SHARE on the live (hub, organization) row, in the organization scope. REQUIRES an active unit of
   * work. Taken by the Room grant and by adding a space before the space lock; unlink holds the row FOR UPDATE.
   */
  abstract lockForShare(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null>;
  /** The live row read in the organization scope (the caller already authorized the reader). */
  abstract findInOrganization(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null>;
  /**
   * Every organization the hub was EVER linked to, tombstones and rejected/revoked links included (ambient context:
   * the hub owner or the hub). Deregistration revokes the Room in all of them.
   */
  abstract listAllOrgIds(hubId: string): Promise<string[]>;
  /**
   * Live links of `organizationId` whose hub belongs to `ownerUserId`, read in the organization scope (no lock).
   * Used by the exit hooks.
   */
  abstract listOwnedInOrganization(
    organizationId: string,
    ownerUserId: string,
  ): Promise<HubOrganizationLink[]>;
  /** Hubs with an approved, live link to `organizationId`, read in the organization scope (no lock). */
  abstract listApprovedHubIdsOfOrganization(
    organizationId: string,
  ): Promise<string[]>;
  /**
   * Deregistration: tombstones every live link of the hub (pending/approved ones become `revoked`), one organization
   * at a time in id order, each in its own scope; returns the organization ids. Ambient context must see the links
   * (the hub owner).
   */
  abstract tombstoneAllOfHub(hubId: string): Promise<string[]>;
}
