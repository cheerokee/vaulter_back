import { Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { assertAuthProof } from '../domain/crypto-material.js';
import { normalizeEmail } from '../domain/email.js';
import { UserRepository } from '../domain/user.repository.js';
import { toLoginResult, type LoginResult } from './dto/login-result.js';
import { AuthProofHasher } from './ports/auth-proof-hasher.js';
import {
  SessionIssuer,
  type ClientInfo,
  type DeviceInput,
} from './session-issuer.js';

@Injectable()
export class LoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: AuthProofHasher,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(input: {
    email: string;
    authProof: string;
    device: DeviceInput;
    client: ClientInfo;
  }): Promise<LoginResult> {
    // A non-string e-mail (the DTO normally prevents it) takes the same path as an unknown one.
    const user =
      typeof input.email === 'string'
        ? await this.users.findByEmail(normalizeEmail(input.email))
        : null;
    // A malformed proof never matches a stored hash; the verification still runs so that
    // neither format nor account existence shows in the response time or the error.
    const wellFormed = isWellFormed(input.authProof);
    if (!user || !wellFormed) {
      await this.hasher.verifyAgainstDummy(
        typeof input.authProof === 'string' ? input.authProof : '',
      );
      throw invalidCredentials();
    }
    if (!(await this.hasher.verify(user.authHash, input.authProof))) {
      throw invalidCredentials();
    }
    const tokens = await this.sessionIssuer.start(
      user,
      input.device,
      input.client,
      new Date(),
    );
    return toLoginResult(user, tokens);
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

function invalidCredentials(): UnauthenticatedError {
  return new UnauthenticatedError(
    'invalid-credentials',
    'Invalid e-mail or password.',
  );
}
