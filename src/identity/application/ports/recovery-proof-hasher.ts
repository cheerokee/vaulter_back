/**
 * Port: keyed hash of the account recovery proof. Synchronous: the proof already carries 256 bits
 * of entropy, so a fast keyed hash (BLAKE2b) is enough; no Argon2 needed.
 */
export abstract class RecoveryProofHasher {
  /** Hex of the keyed hash that is stored instead of the proof. */
  abstract hash(proof: string): string;
  /** Constant-time comparison of `hash(proof)` with the stored hash. */
  abstract verify(storedHash: string, proof: string): boolean;
  /** Same work as `verify` against a fixed hash, to equalise timing when there is no user. */
  abstract verifyAgainstDummy(proof: string): void;
}
