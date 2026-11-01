export type HubSpaceRef = {
  hubId: string;
  spaceId: string;
  organizationId: string;
  addedByUserId: string;
};

export abstract class HubSpaceRepository {
  /** Idempotent; revives a tombstone. */
  abstract add(ref: HubSpaceRef): Promise<void>;
  abstract remove(hubId: string, spaceId: string): Promise<void>;
  abstract list(hubId: string): Promise<HubSpaceRef[]>;
}
