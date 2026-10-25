import { Injectable } from '@nestjs/common';
import { assertAuthProof } from '../domain/crypto-material.js';
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
  device: DeviceInput;
  client: ClientInfo;
};

@Injectable()
export class RegisterUserUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly hasher: AuthProofHasher,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(input: RegisterUserInput): Promise<LoginResult> {
    // Validate everything before the (expensive) hash and before touching the repository.
    assertAuthProof(input.authProof);
    assertDevice(input.device);
    User.validateRegistration(input);

    const now = new Date();
    const authHash = await this.hasher.hash(input.authProof);
    const user = User.register({ ...input, authHash, now });
    await this.users.create(user);

    const tokens = await this.sessionIssuer.start(
      user,
      input.device,
      input.client,
      now,
    );
    return toLoginResult(user, tokens);
  }
}
