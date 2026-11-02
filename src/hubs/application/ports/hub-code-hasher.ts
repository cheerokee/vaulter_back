/** Port: claim codes and auth challenges of the Hub (generation and keyed hashing). */
export abstract class HubCodeHasher {
  /** 8 decimal digits from a CSPRNG, zero-padded. */
  abstract newCode(): string;
  /** Hex of the keyed hash that is stored instead of the code. */
  abstract hash(code: string): Promise<string>;
  /** Hex of the keyed hash of a link code (8 digits, `newCode`), domain-separated from the claim code. */
  abstract hashLinkCode(code: string): Promise<string>;
  /** 32 random bytes, base64url without padding. */
  abstract newChallenge(): string;
  abstract hashChallenge(challenge: string): Promise<string>;
}
