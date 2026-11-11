import { Injectable } from '@nestjs/common';
import { parse } from 'uuid';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import {
  BackupObjectOpener,
  BackupObjectOpenError,
} from '../../application/ports/backup-object-opener.js';

/** docs/crypto/space-backup.md, format v1. */
const FORMAT_VERSION = 0x01;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const AD_LABEL = new TextEncoder().encode('space-object');

function associatedData(ctx: {
  spaceId: string;
  objectId: string;
  keyVersion: number;
}): Uint8Array {
  const ad = new Uint8Array(1 + AD_LABEL.length + 16 + 16 + 4);
  ad[0] = FORMAT_VERSION;
  ad.set(AD_LABEL, 1);
  ad.set(parse(ctx.spaceId), 1 + AD_LABEL.length);
  ad.set(parse(ctx.objectId), 1 + AD_LABEL.length + 16);
  new DataView(ad.buffer).setUint32(1 + AD_LABEL.length + 32, ctx.keyVersion);
  return ad;
}

// Abre um objeto do backup (XChaCha20-Poly1305 IETF, libsodium) com a chave do espaço; o `ad` amarra espaço, objeto e
// versão da chave: um blob de outro objeto/espaço/versão não abre. Nunca registra nada do conteúdo.
@Injectable()
export class SodiumBackupObjectOpener extends BackupObjectOpener {
  async open(
    spaceKey: Uint8Array,
    ctx: { spaceId: string; objectId: string; keyVersion: number },
    blob: Uint8Array,
  ): Promise<Uint8Array> {
    if (
      blob.length < 1 + NONCE_BYTES + TAG_BYTES ||
      blob[0] !== FORMAT_VERSION
    ) {
      throw new BackupObjectOpenError('unknown-format');
    }
    const sodium = await getSodium();
    try {
      return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
        null,
        blob.subarray(1 + NONCE_BYTES),
        associatedData(ctx),
        blob.subarray(1, 1 + NONCE_BYTES),
        spaceKey,
      );
    } catch {
      throw new BackupObjectOpenError('authentication-failed');
    }
  }
}
