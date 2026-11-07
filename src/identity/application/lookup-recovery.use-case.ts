import { Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { assertRecoveryProof } from '../domain/crypto-material.js';
import { normalizeEmail } from '../domain/email.js';
import type { User } from '../domain/user.js';
import { UserRepository } from '../domain/user.repository.js';
import { RecoveryProofHasher } from './ports/recovery-proof-hasher.js';

/** The single error of every failed recovery (unknown e-mail, wrong or malformed proof): no oracle. */
export function recoveryFailed(): UnauthenticatedError {
  return new UnauthenticatedError(
    'recovery-failed',
    'Invalid e-mail or recovery code.',
  );
}

/**
 * Finds the account and checks its recovery proof, shared by both recovery steps. A non-string e-mail, an
 * unknown account and a malformed proof all run the dummy verification and throw the same error, so neither the
 * response nor the hashing work tells them apart from a wrong proof.
 */
export async function verifyRecoveryProof(
  users: UserRepository,
  hasher: RecoveryProofHasher,
  email: unknown,
  recoveryProof: unknown,
): Promise<User> {
  const user =
    typeof email === 'string'
      ? await users.findByEmail(normalizeEmail(email))
      : null;
  if (!user || !isWellFormed(recoveryProof)) {
    hasher.verifyAgainstDummy(
      typeof recoveryProof === 'string' ? recoveryProof : '',
    );
    throw recoveryFailed();
  }
  if (!hasher.verify(user.recoveryHash, recoveryProof)) {
    throw recoveryFailed();
  }
  return user;
}

function isWellFormed(proof: unknown): proof is string {
  if (typeof proof !== 'string') return false;
  try {
    assertRecoveryProof(proof);
    return true;
  } catch {
    return false;
  }
}

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
