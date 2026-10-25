export type SpaceKeyVersion = {
  id: string;
  spaceId: string;
  version: number;
  recoveryWrappedKey: string;
  recoveryKeyFingerprint: string;
};

export abstract class SpaceKeyRepository {
  abstract addVersion(
    orgId: string,
    spaceId: string,
    version: number,
    recoveryWrappedKey: string,
    fingerprint: string,
  ): Promise<SpaceKeyVersion>;
  /** Ascending by version. */
  abstract versions(orgId: string, spaceId: string): Promise<SpaceKeyVersion[]>;
  abstract setRecoveryWrap(
    orgId: string,
    spaceId: string,
    version: number,
    wrappedKey: string,
    fingerprint: string,
  ): Promise<void>;
}
