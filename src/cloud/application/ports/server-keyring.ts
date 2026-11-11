/**
 * The server X25519 key pair (spec active-cloud §3): members seal copies of space and conversation keys to its public
 * key; only the indexing/answering jobs open them, in memory. The private key exists in clear only inside the
 * process (enveloped by KMS at rest) and never leaves this port: no method returns it.
 */
export abstract class ServerKeyring {
  /**
   * The current public key, X25519, 32 bytes as base64url without padding (43 chars). The only method that may CREATE
   * the key (first use, after a rotation), and only outside any unit of work, in a transaction of its own committed
   * before the key is handed out; inside a unit of work with no key yet it throws (programming error).
   */
  abstract publicKey(): Promise<string>;

  /**
   * Loads every stored server key not opened yet in this process (KMS, autocommit reads, no connection held), so that
   * `openSealed` inside the caller's unit of work finds them in memory instead of calling KMS under the transaction.
   * Call it BEFORE `UnitOfWork.run` (inside one it throws). Never creates a key. Cheap when recently prepared.
   */
  abstract prepare(): Promise<void>;

  /**
   * Opens a sealed copy (`0x01 ‖ crypto_box_seal(key, serverPublicKey)`, 108 base64url chars) and returns the 32-byte
   * key. Tries the current server key, then retired ones (copies sealed before a rotation). A malformed copy or one
   * that opens with none of them: 422 `server-copy-invalid`. Never creates a key. The caller owns the returned buffer and must wipe it
   * (`sodium.memzero`) as soon as it is done with it.
   */
  abstract openSealed(copy: string): Promise<Uint8Array>;
}
