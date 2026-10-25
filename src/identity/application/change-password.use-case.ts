import { Injectable } from '@nestjs/common';
import {
  DomainValidationError,
  UnauthenticatedError,
} from '../../shared/domain/errors.js';
import { assertAuthProof } from '../domain/crypto-material.js';
import { SessionRepository } from '../domain/session.repository.js';
import { User } from '../domain/user.js';
import { UserRepository } from '../domain/user.repository.js';
import type { Actor } from './dto/actor.js';
import { AuthProofHasher } from './ports/auth-proof-hasher.js';

export type ChangePasswordInput = {
  currentAuthProof: string;
  newAuthProof: string;
  newKdfSalt: string;
  newKdfParams: unknown;
  newEncryptedPrivateKey: string;
};

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly hasher: AuthProofHasher,
  ) {}

  async execute(auth: Actor, input: ChangePasswordInput): Promise<void> {
    const user = await this.users.findById(auth.userId);
    if (!user) {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'The access token is invalid or expired.',
      );
    }

    // A malformed proof never matches; the dummy verification keeps the timing uniform.
    if (!isWellFormed(input.currentAuthProof)) {
      await this.hasher.verifyAgainstDummy(
        typeof input.currentAuthProof === 'string'
          ? input.currentAuthProof
          : '',
      );
      throw currentProofInvalid();
    }
    if (!(await this.hasher.verify(user.authHash, input.currentAuthProof))) {
      throw currentProofInvalid();
    }

    // Validate the new material before the expensive hash; the domain re-validates the rest.
    assertAuthProof(input.newAuthProof);
    User.validatePasswordChange({
      kdfSalt: input.newKdfSalt,
      kdfParams: input.newKdfParams,
      encryptedPrivateKey: input.newEncryptedPrivateKey,
    });
    const authHash = await this.hasher.hash(input.newAuthProof);
    user.changePassword({
      authHash,
      kdfSalt: input.newKdfSalt,
      kdfParams: input.newKdfParams,
      encryptedPrivateKey: input.newEncryptedPrivateKey,
    });
    await this.users.save(user);
    await this.sessions.revokeAllForUser(
      auth.userId,
      'password_change',
      new Date(),
      auth.sessionId,
    );
  }
}

function isWellFormed(proof: unknown): proof is string {
  if (typeof proof !== 'string') return false;
  try {
    assertAuthProof(proof);
    return true;
  } catch {
    return false;
  }
}

function currentProofInvalid(): DomainValidationError {
  return new DomainValidationError(
    'current-auth-proof-invalid',
    'The current password is incorrect.',
  );
}
