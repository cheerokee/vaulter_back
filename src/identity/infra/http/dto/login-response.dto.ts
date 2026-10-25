import type { LoginResult } from '../../../application/dto/login-result.js';
import { SessionTokensResponse } from './session-tokens-response.dto.js';

export class UserResponse {
  id!: string;
  name!: string;
  email!: string;
  createdAt!: string;
}

export class KeysResponse {
  publicKey!: string;
  encryptedPrivateKey!: string;
  kdfSalt!: string;
  kdfParams!: { algorithm: string; opsLimit: number; memLimitBytes: number };
}

export class LoginResponse {
  user!: UserResponse;
  keys!: KeysResponse;
  session!: SessionTokensResponse;

  static from(result: LoginResult): LoginResponse {
    const res = new LoginResponse();
    res.user = {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      createdAt: result.user.createdAt.toISOString(),
    };
    res.keys = {
      publicKey: result.keys.publicKey,
      encryptedPrivateKey: result.keys.encryptedPrivateKey,
      kdfSalt: result.keys.kdfSalt,
      kdfParams: { ...result.keys.kdfParams },
    };
    res.session = SessionTokensResponse.from(result.session);
    return res;
  }
}
