import { Injectable } from '@nestjs/common';
import { UserRepository } from '../domain/user.repository.js';
import { RecoveryProofHasher } from './ports/recovery-proof-hasher.js';
import { verifyRecoveryProof } from './recovery-proof.js';

/** Step 1 of the account recovery: the right proof gets back the private key sealed with the recovery code. */
@Injectable()
export class LookupRecoveryUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly recoveryHasher: RecoveryProofHasher,
  ) {}

  async execute(input: {
    email: string;
    recoveryProof: string;
  }): Promise<{ recoveryEncryptedPrivateKey: string }> {
    const user = await verifyRecoveryProof(
      this.users,
      this.recoveryHasher,
      input.email,
      input.recoveryProof,
    );
    return { recoveryEncryptedPrivateKey: user.recoveryEncryptedPrivateKey };
  }
}
