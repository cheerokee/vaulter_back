/**
 * The server X25519 key pair (spec active-cloud §3): members seal copies of space and conversation keys to its public
 * key; only the indexing/answering jobs open them, in memory. The private key exists in clear only inside the
 * process (enveloped by KMS at rest) and never leaves this port: no method returns it.
 */
export abstract class ServerKeyring {
  /** The current public key, X25519, 32 bytes as base64url without padding (43 chars). */
  abstract publicKey(): Promise<string>;

  /**
   * Opens a sealed copy (`0x01 ‖ crypto_box_seal(key, serverPublicKey)`, 108 base64url chars) and returns the 32-byte
   * key. Tries the current server key, then retired ones (copies sealed before a rotation). A malformed copy or one
   * that opens with none of them: 422 `server-copy-invalid`. The caller owns the returned buffer and must wipe it
   * (`sodium.memzero`) as soon as it is done with it.
   */
  abstract openSealed(copy: string): Promise<Uint8Array>;
}
