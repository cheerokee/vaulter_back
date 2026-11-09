import { Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { assertAuthProof } from '../domain/crypto-material.js';
import { normalizeEmail } from '../domain/email.js';
import type { User } from '../domain/user.js';
import { UserRepository } from '../domain/user.repository.js';
import { AuthProofHasher } from './ports/auth-proof-hasher.js';

/**
 * E-mail + auth proof check shared by every login (`/auth/login` and the login through a hub). Always runs ONE
 * Argon2id verification, so neither account existence nor the proof format shows in the response time.
 */
@Injectable()
export class CredentialCheck {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: AuthProofHasher,
  ) {}

  /** The user whose proof matches, or null (unknown e-mail, malformed or wrong proof). */
  async verify(email: unknown, authProof: unknown): Promise<User | null> {
    // A non-string e-mail (the DTO normally prevents it) takes the same path as an unknown one.
    const user =
      typeof email === 'string'
        ? await this.users.findByEmail(normalizeEmail(email))
        : null;
    // A malformed proof never matches a stored hash; the verification still runs so that
    // neither format nor account existence shows in the response time or the error.
    if (!user || !isWellFormed(authProof)) {
      await this.hasher.verifyAgainstDummy(
        typeof authProof === 'string' ? authProof : '',
      );
      return null;
    }
    return (await this.hasher.verify(user.authHash, authProof)) ? user : null;
  }
}

function isWellFormed(authProof: unknown): authProof is string {
  if (typeof authProof !== 'string') return false;
  try {
    assertAuthProof(authProof);
    return true;
  } catch {
    return false;
  }
}

/** The one login error: wrong e-mail, wrong password, a refused platform or no role on the hub look the same. */
export function invalidCredentials(): UnauthenticatedError {
  return new UnauthenticatedError(
    'invalid-credentials',
    'Invalid e-mail or password.',
  );
}
