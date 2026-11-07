import { Injectable, Logger } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertAuthProof } from '../domain/crypto-material.js';
import { assertDevice } from '../domain/session.js';
import { SessionRepository } from '../domain/session.repository.js';
import { User } from '../domain/user.js';
import { UserRepository } from '../domain/user.repository.js';
import { toLoginResult, type LoginResult } from './dto/login-result.js';
import { verifyRecoveryProof } from './lookup-recovery.use-case.js';
import { AuthProofHasher } from './ports/auth-proof-hasher.js';
import { RecoveryProofHasher } from './ports/recovery-proof-hasher.js';
import {
  SessionIssuer,
  type ClientInfo,
  type DeviceInput,
} from './session-issuer.js';

export type CompleteRecoveryInput = {
  email: string;
  recoveryProof: string;
  newAuthProof: string;
  newKdfSalt: string;
  newKdfParams: unknown;
  newEncryptedPrivateKey: string;
  device: DeviceInput;
  client: ClientInfo;
};

/**
 * Step 2 of the account recovery: checks the recovery proof on its own (step 1 is not required), sets the new
 * password material, revokes EVERY session of the user and opens a new one for this device. The recovery code
 * stays the same (the app suggests generating a new one right after).
 */
@Injectable()
export class CompleteRecoveryUseCase {
  private readonly logger = new Logger(CompleteRecoveryUseCase.name);

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly authHasher: AuthProofHasher,
    private readonly recoveryHasher: RecoveryProofHasher,
    private readonly sessionIssuer: SessionIssuer,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(input: CompleteRecoveryInput): Promise<LoginResult> {
    // The new material is validated first: a 422 here says nothing about the account or the proof.
    assertAuthProof(input.newAuthProof);
    const newMaterial = {
      kdfSalt: input.newKdfSalt,
      kdfParams: input.newKdfParams,
      encryptedPrivateKey: input.newEncryptedPrivateKey,
    };
    User.validatePasswordChange(newMaterial);
    assertDevice(input.device);

    const user = await verifyRecoveryProof(
      this.users,
      this.recoveryHasher,
      input.email,
      input.recoveryProof,
    );
    // Only after the proof: the Argon2id hash is the expensive part.
    const authHash = await this.authHasher.hash(input.newAuthProof);
    const now = new Date();
    const tokens = await this.uow.run(async () => {
      user.changePassword({ authHash, ...newMaterial });
      await this.users.save(user);
      await this.sessions.revokeAllForUser(user.id, 'account_recovery', now);
      return this.sessionIssuer.start(user, input.device, input.client, now);
    });
    this.logger.log({ event: 'account.recovered', userId: user.id });
    return toLoginResult(user, tokens);
  }
}
