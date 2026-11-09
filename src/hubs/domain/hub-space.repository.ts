import type { KeysetSlice } from '../../shared/domain/pagination.js';
export type HubSpaceRef = {
  hubId: string;
  spaceId: string;
  organizationId: string;
  addedByUserId: string;
};

export abstract class HubSpaceRepository {
  /** Idempotent; revives a tombstone. */
  abstract add(ref: HubSpaceRef): Promise<void>;
  /** Tombstones the live row in the organization scope; true when there was one. */
  abstract remove(
    hubId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<boolean>;
  /** Tombstones every live row of the hub in `organizationId`; returns the space ids. */
  abstract removeAllOfOrganization(
    hubId: string,
    organizationId: string,
  ): Promise<string[]>;
  /** Live row in the ambient context (the hub owner sees every row of the hub). */
  abstract find(hubId: string, spaceId: string): Promise<HubSpaceRef | null>;
  /** SELECT ... FOR SHARE on the live row, in the organization scope. REQUIRES an active unit of work. */
  abstract lockForShare(
    hubId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<HubSpaceRef | null>;
  /**
   * SELECT ... FOR UPDATE on every live row of the hub in `organizationId` (space id order), in the organization
   * scope; returns the space ids. REQUIRES an active unit of work. Taken by the owner-exit hook before any space lock.
   */
  abstract lockAllOfOrganization(
    hubId: string,
    organizationId: string,
  ): Promise<string[]>;
  /** Live rows of the hub in the ambient context, by space id; `slice` = only ids after `after`, at most `limit`. */
  abstract list(hubId: string, slice?: KeysetSlice): Promise<HubSpaceRef[]>;
  /** Live rows of the hub in `organizationId`, read in the organization scope, by space id (`slice` as in `list`). */
  abstract listInOrganization(
    hubId: string,
    organizationId: string,
    slice?: KeysetSlice,
  ): Promise<HubSpaceRef[]>;
  /** Hubs where the space is installed (live rows), read in the organization scope, in hub id order. */
  abstract hubIdsOfSpace(
    organizationId: string,
    spaceId: string,
  ): Promise<string[]>;
  /**
   * Sum of the reserved sizes of the live spaces installed on the hub: in every organization the hub was ever linked
   * to (`organizationIds` omitted: the capacity check and the owner's view), or only in the given ones (what a
   * non-owner may see). Each organization is read in its own RLS scope. Trusted read: authorization is the caller's.
   */
  abstract reservedBytes(
    hubId: string,
    organizationIds?: readonly string[],
  ): Promise<number>;
}
