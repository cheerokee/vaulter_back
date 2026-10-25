import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { DecoySaltFactory } from '../../application/ports/decoy-salt-factory.js';

@Injectable()
export class SodiumDecoySaltFactory extends DecoySaltFactory {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async saltFor(normalizedEmail: string): Promise<string> {
    const sodium = await getSodium();
    const key = sodium.from_base64(
      this.config.getOrThrow<string>('IDENTITY_DECOY_SALT_KEY'),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
    const salt = sodium.crypto_generichash(
      sodium.crypto_pwhash_SALTBYTES,
      normalizedEmail,
      key,
    );
    return sodium.to_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING);
  }
}
