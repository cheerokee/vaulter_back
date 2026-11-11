/** A conversation message blob that does not open (wrong key, other record, tampered, unknown format). */
export class ConversationBlobOpenError extends Error {
  constructor() {
    super('conversation message does not open');
    this.name = 'ConversationBlobOpenError';
  }
}

export type ConversationMessageContext = {
  spaceId: string;
  conversationId: string;
  messageId: string;
  keyVersion: number;
};

/**
 * The cloud executor's symmetric crypto (libsodium XChaCha20-Poly1305): conversation messages
 * (docs/crypto/conversations.md, label `conversation-message`) and backup objects (docs/crypto/space-backup.md). Keys
 * are opened by `ServerKeyring` and wiped by the caller; plaintexts are the caller's to wipe. Never logs anything.
 */
export abstract class CloudCipher {
  abstract openMessage(
    conversationKey: Uint8Array,
    ctx: ConversationMessageContext,
    blob: Uint8Array,
  ): Promise<Uint8Array>;
  abstract sealMessage(
    conversationKey: Uint8Array,
    ctx: ConversationMessageContext,
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
  abstract sealBackupObject(
    spaceKey: Uint8Array,
    ctx: { spaceId: string; objectId: string; keyVersion: number },
    plaintext: Uint8Array,
  ): Promise<Uint8Array>;
}
