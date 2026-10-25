import { Injectable } from '@nestjs/common';
import {
  DomainValidationError,
  UnauthenticatedError,
} from '../../shared/domain/errors.js';
import { assertAuthProof } from '../domain/crypto-material.js';
import { UserRepository } from '../domain/user.repository.js';
import { AuthProofHasher } from './ports/auth-proof-hasher.js';

// Reautenticação: confere a prova de senha atual do usuário (troca de senha, troca do kit de recuperação).
@Injectable()
export class CurrentAuthProofVerifier {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: AuthProofHasher,
  ) {}

  async verify(userId: string, currentAuthProof: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'The access token is invalid or expired.',
      );
    }
    // A malformed proof never matches; the dummy verification keeps the timing uniform.
    if (!isWellFormed(currentAuthProof)) {
      await this.hasher.verifyAgainstDummy(
        typeof currentAuthProof === 'string' ? currentAuthProof : '',
      );
      throw currentProofInvalid();
    }
    if (!(await this.hasher.verify(user.authHash, currentAuthProof))) {
      throw currentProofInvalid();
    }
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
