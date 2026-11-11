/** The blob does not open with that key for that object (wrong key, other object/space/version, tampered, unknown format). */
export class BackupObjectOpenError extends Error {
  constructor(readonly reason: 'unknown-format' | 'authentication-failed') {
    super(`backup object does not open: ${reason}`);
    this.name = 'BackupObjectOpenError';
  }
}

/**
 * Opens a backup object (docs/crypto/space-backup.md: `0x01 ‖ nonce(24) ‖ XChaCha20-Poly1305(plaintext, ad)`, `ad`
 * binding space, object and key version). The caller owns the returned plaintext and must wipe it when done.
 */
export abstract class BackupObjectOpener {
  abstract open(
    spaceKey: Uint8Array,
    ctx: { spaceId: string; objectId: string; keyVersion: number },
    blob: Uint8Array,
  ): Promise<Uint8Array>;
}
