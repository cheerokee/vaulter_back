import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { DecoySaltFactory } from '../../application/ports/decoy-salt-factory.js';

@Injectable()
export class SodiumDecoySaltFactory
  extends DecoySaltFactory
  implements OnModuleInit
{
  private key?: Uint8Array;

  constructor(private readonly config: ConfigService) {
    super();
  }

  /** Decodes the key at boot: a malformed key fails startup instead of every pre-login. */
  async onModuleInit(): Promise<void> {
    const sodium = await getSodium();
    this.key = sodium.from_base64(
      this.config.getOrThrow<string>('IDENTITY_DECOY_SALT_KEY'),
      sodium.base64_variants.URLSAFE_NO_PADDING,
    );
  }

  async saltFor(normalizedEmail: string): Promise<string> {
    const sodium = await getSodium();
    const key = this.key;
    if (!key) throw new Error('SodiumDecoySaltFactory not initialised');
    const salt = sodium.crypto_generichash(
      sodium.crypto_pwhash_SALTBYTES,
      normalizedEmail,
      key,
    );
    return sodium.to_base64(salt, sodium.base64_variants.URLSAFE_NO_PADDING);
  }
}
