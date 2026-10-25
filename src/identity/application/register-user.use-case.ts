import { Injectable } from '@nestjs/common';
import { assertAuthProof } from '../domain/crypto-material.js';
import { RegistrationHooks } from '../../shared/application/registration-hooks.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { UserRepository } from '../domain/user.repository.js';
import { assertDevice } from '../domain/session.js';
import { User } from '../domain/user.js';
import { toLoginResult, type LoginResult } from './dto/login-result.js';
import { AuthProofHasher } from './ports/auth-proof-hasher.js';
import {
  SessionIssuer,
  type ClientInfo,
  type DeviceInput,
} from './session-issuer.js';

export type RegisterUserInput = {
  name: string;
  email: string;
  authProof: string;
  kdfSalt: string;
  kdfParams: unknown;
  publicKey: string;
  encryptedPrivateKey: string;
  inviteToken?: string;
  device: DeviceInput;
  client: ClientInfo;
};

@Injectable()
export class RegisterUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: AuthProofHasher,
    private readonly sessionIssuer: SessionIssuer,
    private readonly uow: UnitOfWork,
    private readonly hooks: RegistrationHooks,
  ) {}

  async execute(input: RegisterUserInput): Promise<LoginResult> {
    // Validate everything before the (expensive) hash and before touching the repository.
    assertAuthProof(input.authProof);
    assertDevice(input.device);
    User.validateRegistration(input);

    const now = new Date();
    const authHash = await this.hasher.hash(input.authProof);
    const user = User.register({ ...input, authHash, now });
    // User, hooks (e.g. personal organization) and session commit together; any failure undoes all.
    const { tokens, hookResult } = await this.uow.run(async () => {
      await this.users.create(user);
      const hookResult = await this.hooks.run({
        userId: user.id,
        name: user.name,
        email: user.email,
        inviteToken: input.inviteToken,
        now,
      });
      const tokens = await this.sessionIssuer.start(
        user,
        input.device,
        input.client,
        now,
      );
      return { tokens, hookResult };
    });
    const result = toLoginResult(user, tokens);
    if (hookResult.invitation) result.invitation = hookResult.invitation;
    return result;
  }
}
