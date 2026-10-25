import { Injectable } from '@nestjs/common';
import { isUuidV7 } from '../../../shared/domain/id.js';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { RefreshTokenCodec } from '../../application/ports/refresh-token-codec.js';

// Sodium is ready at module load so that `parse` can stay synchronous.
const sodium = await getSodium();
const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
const SECRET_BYTES = 32;
const SECRET_CHARS = 43;
const MAX_TOKEN_CHARS = 128;
const SECRET_FORMAT = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

// The stored hash is BLAKE2b-256 of the DECODED secret bytes (not of its text), hex-encoded.
function hashSecret(secret: Uint8Array): string {
  return sodium.to_hex(sodium.crypto_generichash(32, secret, null));
}

@Injectable()
export class SodiumRefreshTokenCodec extends RefreshTokenCodec {
  generate(sessionId: string): Promise<{ token: string; hash: string }> {
    const secret = sodium.randombytes_buf(SECRET_BYTES);
    return Promise.resolve({
      token: `${sessionId}.${sodium.to_base64(secret, B64)}`,
      hash: hashSecret(secret),
    });
  }

  parse(token: string): { sessionId: string; hash: string } | null {
    if (token.length > MAX_TOKEN_CHARS) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [sessionId, secretText] = parts as [string, string];
    if (!isUuidV7(sessionId)) return null;
    if (secretText.length !== SECRET_CHARS || !SECRET_FORMAT.test(secretText))
      return null;
    const secret = sodium.from_base64(secretText, B64);
    if (secret.length !== SECRET_BYTES) return null;
    return { sessionId, hash: hashSecret(secret) };
  }
}
