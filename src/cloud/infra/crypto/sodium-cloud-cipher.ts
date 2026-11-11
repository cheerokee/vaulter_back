import { Injectable } from '@nestjs/common';
import { parse } from 'uuid';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import {
  CloudCipher,
  ConversationBlobOpenError,
  type ConversationMessageContext,
} from '../../application/ports/cloud-cipher.js';

const FORMAT_VERSION = 0x01;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const MESSAGE_LABEL = new TextEncoder().encode('conversation-message');
const SPACE_OBJECT_LABEL = new TextEncoder().encode('space-object');

/** `0x01 ‖ label ‖ uuids (16 raw bytes each) ‖ keyVersion (uint32 BE)`: the AD of both formats. */
function associatedData(
  label: Uint8Array,
  uuids: readonly string[],
  keyVersion: number,
): Uint8Array {
  const ad = new Uint8Array(1 + label.length + 16 * uuids.length + 4);
  ad[0] = FORMAT_VERSION;
  ad.set(label, 1);
  uuids.forEach((id, i) => ad.set(parse(id), 1 + label.length + 16 * i));
  new DataView(ad.buffer).setUint32(
    1 + label.length + 16 * uuids.length,
    keyVersion,
  );
  return ad;
}

async function seal(
  key: Uint8Array,
  ad: Uint8Array,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const sodium = await getSodium();
  const nonce = sodium.randombytes_buf(NONCE_BYTES);
  const ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    plaintext,
    ad,
    null,
    nonce,
    key,
  );
  const blob = new Uint8Array(1 + NONCE_BYTES + ct.length);
  blob[0] = FORMAT_VERSION;
  blob.set(nonce, 1);
  blob.set(ct, 1 + NONCE_BYTES);
  return blob;
}

const messageAd = (ctx: ConversationMessageContext) =>
  associatedData(
    MESSAGE_LABEL,
    [ctx.spaceId, ctx.conversationId, ctx.messageId],
    ctx.keyVersion,
  );

// docs/crypto/conversations.md (mensagem) e docs/crypto/space-backup.md (objeto do backup), formato v1.
@Injectable()
export class SodiumCloudCipher extends CloudCipher {
  async openMessage(
    conversationKey: Uint8Array,
    ctx: ConversationMessageContext,
    blob: Uint8Array,
  ): Promise<Uint8Array> {
    if (
      blob.length < 1 + NONCE_BYTES + TAG_BYTES ||
      blob[0] !== FORMAT_VERSION
    ) {
      throw new ConversationBlobOpenError();
    }
    const sodium = await getSodium();
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        blob.subarray(1 + NONCE_BYTES),
        messageAd(ctx),
        blob.subarray(1, 1 + NONCE_BYTES),
        conversationKey,
      );
    } catch {
      throw new ConversationBlobOpenError();
    }
  }

  sealMessage(
    conversationKey: Uint8Array,
    ctx: ConversationMessageContext,
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    return seal(conversationKey, messageAd(ctx), plaintext);
  }

  sealBackupObject(
    spaceKey: Uint8Array,
    ctx: { spaceId: string; objectId: string; keyVersion: number },
    plaintext: Uint8Array,
  ): Promise<Uint8Array> {
    return seal(
      spaceKey,
      associatedData(
        SPACE_OBJECT_LABEL,
        [ctx.spaceId, ctx.objectId],
        ctx.keyVersion,
      ),
      plaintext,
    );
  }
}
