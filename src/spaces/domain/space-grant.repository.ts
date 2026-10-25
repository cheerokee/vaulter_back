export type SpaceGrant = {
  spaceKeyId: string;
  version: number;
  wrappedKey: string;
};

export abstract class SpaceGrantRepository {
  /** Inserts or updates; clears the tombstone of a returning member. */
  abstract upsert(
    orgId: string,
    spaceKeyId: string,
    userId: string,
    wrappedKey: string,
  ): Promise<void>;
  /** Active grants of the user in the space, ascending by version. */
  abstract forUser(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<SpaceGrant[]>;
  abstract tombstoneUser(
    orgId: string,
    spaceId: string,
    userId: string,
  ): Promise<void>;
  /** Tombstones the user's grants in every space of the organization; returns the affected space ids. */
  abstract tombstoneUserInOrg(orgId: string, userId: string): Promise<string[]>;
}
