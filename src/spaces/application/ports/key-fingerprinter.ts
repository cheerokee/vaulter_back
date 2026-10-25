/** Port: fingerprint of a recovery kit public key (libsodium implementation lives in infra). */
export abstract class KeyFingerprinter {
  /** Hex of crypto_generichash(32, decoded public key bytes): 64 hex chars. */
  abstract fingerprint(publicKeyB64u: string): Promise<string>;
}
