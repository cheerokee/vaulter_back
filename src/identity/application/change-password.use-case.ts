import { Injectable } from '@nestjs/common';
import { UnauthenticatedError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
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
    private readonly uow: UnitOfWork,
  ) {}

  async execute(auth: Actor, input: ChangePasswordInput): Promise<void> {
    // The password the proof is checked against, read BEFORE the check: the write below only goes ahead while the row
    // still has it (see the lock).
    const before = await this.users.findById(auth.userId);
    // Reauthentication first: wrong or malformed proof (uniform timing) and missing user are rejected there.
    await this.currentProof.verify(auth.userId, input.currentAuthProof);
    if (!before) throw invalidAccessToken();

    // Validate the new material before the expensive hash; the domain re-validates the rest.
    assertAuthProof(input.newAuthProof);
    User.validatePasswordChange({
      kdfSalt: input.newKdfSalt,
      kdfParams: input.newKdfParams,
      encryptedPrivateKey: input.newEncryptedPrivateKey,
    });
    const authHash = await this.hasher.hash(input.newAuthProof);
    await this.uow.run(async () => {
      // Under the row lock (the one the account recovery takes): a recovery (or another password change) that
      // committed since the proof was checked changed the password and revoked this session; it wins, never
      // overwritten by a change verified against the old password.
      const user = await this.users.findByIdForUpdate(auth.userId);
      if (!user || user.authHash !== before.authHash) {
        throw invalidAccessToken();
      }
      user.changePassword({
        authHash,
        kdfSalt: input.newKdfSalt,
        kdfParams: input.newKdfParams,
        encryptedPrivateKey: input.newEncryptedPrivateKey,
      });
      await this.users.updatePasswordMaterial(user);
      await this.sessions.revokeAllForUser(
        auth.userId,
        'password_change',
        new Date(),
        auth.sessionId,
      );
    });
  }
}

function invalidAccessToken(): UnauthenticatedError {
  return new UnauthenticatedError(
    'invalid-access-token',
    'The access token is invalid or expired.',
  );
}
