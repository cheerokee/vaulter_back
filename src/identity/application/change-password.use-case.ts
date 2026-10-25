import { Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { assertAuthProof } from '../domain/crypto-material.js';
import { SessionRepository } from '../domain/session.repository.js';
import { User } from '../domain/user.js';
import { UserRepository } from '../domain/user.repository.js';
import type { Actor } from './dto/actor.js';
import { CurrentAuthProofVerifier } from './current-auth-proof-verifier.js';
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
    private readonly currentProof: CurrentAuthProofVerifier,
  ) {}

  async execute(auth: Actor, input: ChangePasswordInput): Promise<void> {
    // Reauthentication first: wrong or malformed proof (uniform timing) and missing user are rejected there.
    await this.currentProof.verify(auth.userId, input.currentAuthProof);
    const user = await this.users.findById(auth.userId);
    if (!user) {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'The access token is invalid or expired.',
      );
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
