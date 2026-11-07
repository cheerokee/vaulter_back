import { Injectable, Logger } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import {
  assertRecoveryEncryptedPrivateKey,
  assertRecoveryProof,
} from '../domain/crypto-material.js';
import { UserRepository } from '../domain/user.repository.js';
import type { Actor } from './dto/actor.js';
import { CurrentAuthProofVerifier } from './current-auth-proof-verifier.js';
import { RecoveryProofHasher } from './ports/recovery-proof-hasher.js';

export type ChangeRecoveryCodeInput = {
  currentAuthProof: string;
  newRecoveryProof: string;
  newRecoveryEncryptedPrivateKey: string;
};

/**
 * Replaces the recovery code: the new proof (stored only as a hash) and the private key sealed with the new
 * code. Needs the current password proof (reauthentication). Does not revoke sessions: nothing about the
 * password or the sessions changes.
 */
@Injectable()
export class ChangeRecoveryCodeUseCase {
  private readonly logger = new Logger(ChangeRecoveryCodeUseCase.name);

  constructor(
    private readonly users: UserRepository,
    private readonly recoveryHasher: RecoveryProofHasher,
    private readonly currentProof: CurrentAuthProofVerifier,
  ) {}

  async execute(auth: Actor, input: ChangeRecoveryCodeInput): Promise<void> {
    // Reauthentication first, like the password change.
    await this.currentProof.verify(auth.userId, input.currentAuthProof);
    const user = await this.users.findById(auth.userId);
    if (!user) {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'The access token is invalid or expired.',
      );
    }
    assertRecoveryProof(input.newRecoveryProof);
    assertRecoveryEncryptedPrivateKey(input.newRecoveryEncryptedPrivateKey);
    user.changeRecoveryCode({
      recoveryHash: this.recoveryHasher.hash(input.newRecoveryProof),
      recoveryEncryptedPrivateKey: input.newRecoveryEncryptedPrivateKey,
    });
    await this.users.save(user);
    this.logger.log({
      event: 'account.recovery_code_changed',
      userId: user.id,
    });
  }
}
