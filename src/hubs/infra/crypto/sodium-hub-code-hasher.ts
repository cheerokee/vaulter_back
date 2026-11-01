import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { HubCodeHasher } from '../../application/ports/hub-code-hasher.js';

// Sodium is ready at module load so that the generators can stay synchronous.
const sodium = await getSodium();
const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
const CODE_SPACE = 100_000_000;

// Domain separation: the same key hashes two kinds of input, so each gets its own prefix.
const CODE_PREFIX = 'hub-claim-code-v1\0';
const CHALLENGE_PREFIX = 'hub-auth-challenge-v1\0';

@Injectable()
export class SodiumHubCodeHasher extends HubCodeHasher implements OnModuleInit {
  private key?: Uint8Array;

  constructor(private readonly config: ConfigService) {
    super();
  }

  /** Decodes the key at boot: a malformed key fails startup instead of every enrollment. */
  onModuleInit(): void {
    this.key = sodium.from_base64(
      this.config.getOrThrow<string>('HUB_CODE_HASH_KEY'),
      B64,
    );
  }

  newCode(): string {
    // randombytes_uniform rejects values to avoid modulo bias.
    return String(sodium.randombytes_uniform(CODE_SPACE)).padStart(8, '0');
  }

  hash(code: string): Promise<string> {
    return Promise.resolve(this.keyed(CODE_PREFIX + code));
  }

  newChallenge(): string {
    return sodium.to_base64(sodium.randombytes_buf(32), B64);
  }

  hashChallenge(challenge: string): Promise<string> {
    return Promise.resolve(this.keyed(CHALLENGE_PREFIX + challenge));
  }

  private keyed(input: string): string {
    const key = this.key;
    if (!key) throw new Error('SodiumHubCodeHasher not initialised');
    return sodium.to_hex(
      sodium.crypto_generichash(32, Buffer.from(input, 'utf8'), key),
    );
  }
}
