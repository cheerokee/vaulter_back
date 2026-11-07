import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { RecoveryProofHasher } from '../../application/ports/recovery-proof-hasher.js';

// Sodium is ready at module load so that the hasher can stay synchronous.
const sodium = await getSodium();
const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
const HASH_BYTES = 32;

// Domain separation: the context label never contains the product name (docs/crypto/user-keys.md).
const PREFIX = 'account-recovery-proof-v1\0';
// Fixed comparison target for verifyAgainstDummy (never the hash of a real proof).
const DUMMY_HASH = new Uint8Array(HASH_BYTES);

@Injectable()
export class SodiumRecoveryProofHasher
  extends RecoveryProofHasher
  implements OnModuleInit
{
  private key?: Uint8Array;

  constructor(private readonly config: ConfigService) {
    super();
  }

  /** Decodes the key at boot: a malformed key fails startup instead of every recovery. */
  onModuleInit(): void {
    this.key = sodium.from_base64(
      this.config.getOrThrow<string>('IDENTITY_RECOVERY_HASH_KEY'),
      B64,
    );
  }

  hash(proof: string): string {
    return sodium.to_hex(this.keyed(proof));
  }

  verify(storedHash: string, proof: string): boolean {
    const computed = this.keyed(proof);
    const stored = /^[0-9a-f]{64}$/.test(storedHash)
      ? sodium.from_hex(storedHash)
      : DUMMY_HASH;
    // Constant time; a malformed stored hash is compared against the dummy and still fails.
    return sodium.memcmp(computed, stored) && stored !== DUMMY_HASH;
  }

  verifyAgainstDummy(proof: string): void {
    sodium.memcmp(this.keyed(proof), DUMMY_HASH);
  }

  private keyed(proof: string): Uint8Array {
    const key = this.key;
    if (!key) throw new Error('SodiumRecoveryProofHasher not initialised');
    return sodium.crypto_generichash(
      HASH_BYTES,
      Buffer.from(PREFIX + proof, 'utf8'),
      key,
    );
  }
}
