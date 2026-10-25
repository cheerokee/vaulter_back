import { Injectable } from '@nestjs/common';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { InvitationTokenCodec } from '../../application/ports/invitation-token-codec.js';

// Sodium is ready at module load so that the codec can stay synchronous.
const sodium = await getSodium();
const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
const SECRET_BYTES = 32;
// 43 chars; the last one carries only 4 bits, so only these values are canonical.
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

// Same scheme as the refresh token: the stored hash is BLAKE2b-256 of the DECODED bytes, hex-encoded.
function hashSecret(secret: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_generichash(32, secret, null));
}

@Injectable()
export class SodiumInvitationTokenCodec extends InvitationTokenCodec {
  generate(): { token: string; tokenHash: string } {
    const secret = sodium.randombytes_buf(SECRET_BYTES);
    return {
      token: sodium.to_base64(secret, B64),
      tokenHash: hashSecret(secret),
    };
  }

  hash(token: string): string | null {
    if (typeof token !== 'string' || !TOKEN_FORMAT.test(token)) return null;
    const secret = sodium.from_base64(token, B64);
    return secret.length === SECRET_BYTES ? hashSecret(secret) : null;
  }
}
