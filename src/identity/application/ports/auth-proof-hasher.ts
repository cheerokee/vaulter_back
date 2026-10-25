/** Port: hashes the login proof (Argon2id) before it is stored or compared. */
export abstract class AuthProofHasher {
  abstract hash(authProof: string): Promise<string>;
  abstract verify(authHash: string, authProof: string): Promise<boolean>;
  /** Runs a full verification against a fixed hash to equalise timing; always false. */
  abstract verifyAgainstDummy(authProof: string): Promise<false>;
}
