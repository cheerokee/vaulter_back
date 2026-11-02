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
  abstract list(hubId: string): Promise<HubSpaceRef[]>;
  /** Live rows of the hub in `organizationId`, read in the organization scope. */
  abstract listInOrganization(
    hubId: string,
    organizationId: string,
  ): Promise<HubSpaceRef[]>;
}
