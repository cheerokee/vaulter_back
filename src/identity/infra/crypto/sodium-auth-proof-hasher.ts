import { Injectable } from '@nestjs/common';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { AuthProofHasher } from '../../application/ports/auth-proof-hasher.js';

// OWASP minimum for Argon2id: 2 iterations, 19 MiB.
const OPS_LIMIT = 2;
const MEM_LIMIT = 19_922_944;
const DUMMY_PROOF = 'dummy-auth-proof-for-timing-equalisation';

@Injectable()
export class SodiumAuthProofHasher extends AuthProofHasher {
  private dummyHash?: Promise<string>;

  async hash(authProof: string): Promise<string> {
    const sodium = await getSodium();
    return sodium.crypto_pwhash_str(authProof, OPS_LIMIT, MEM_LIMIT);
  }

  async verify(authHash: string, authProof: string): Promise<boolean> {
    const sodium = await getSodium();
    try {
      return sodium.crypto_pwhash_str_verify(authHash, authProof);
    } catch {
      return false;
    }
  }

  async verifyAgainstDummy(authProof: string): Promise<false> {
    this.dummyHash ??= this.hash(DUMMY_PROOF);
    await this.verify(await this.dummyHash, authProof);
    return false;
  }
}
