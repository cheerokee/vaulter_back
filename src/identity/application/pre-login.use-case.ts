import { Injectable } from '@nestjs/common';
import { DEFAULT_KDF_PARAMS, type KdfParams } from '../domain/kdf-params.js';
import { normalizeEmail } from '../domain/email.js';
import { UserRepository } from '../domain/user.repository.js';
import { DecoySaltFactory } from './ports/decoy-salt-factory.js';

@Injectable()
export class PreLoginUseCase {
  constructor(
    private readonly users: UserRepository,
    private readonly decoySalts: DecoySaltFactory,
  ) {}

  async execute(input: {
    email: string;
  }): Promise<{ kdfSalt: string; kdfParams: KdfParams }> {
    const email = normalizeEmail(input.email);
    const user = await this.users.findByEmail(email);
    if (user) return { kdfSalt: user.kdfSalt, kdfParams: user.kdfParams };
    return {
      kdfSalt: await this.decoySalts.saltFor(email),
      kdfParams: { ...DEFAULT_KDF_PARAMS },
    };
  }
}
