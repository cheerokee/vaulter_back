/** Port: generates the invitation secret and hashes it (libsodium implementation lives in infra). */
export abstract class InvitationTokenCodec {
  /** 32 random bytes as base64url + hex of crypto_generichash(32, bytes). */
  abstract generate(): { token: string; tokenHash: string };
  /** Hash of a token received from a link; null when the token is malformed. */
  abstract hash(token: string): string | null;
}
