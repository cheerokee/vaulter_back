import { Injectable } from '@nestjs/common';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { KeyFingerprinter } from '../../application/ports/key-fingerprinter.js';

@Injectable()
export class SodiumKeyFingerprinter extends KeyFingerprinter {
  async fingerprint(publicKeyB64u: string): Promise<string> {
    const sodium = await getSodium();
    const bytes = sodium.from_base64(
      publicKeyB64u,
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    return sodium.to_hex(sodium.crypto_generichash(32, bytes, null));
  }
}
