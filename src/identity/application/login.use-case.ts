import { Injectable } from '@nestjs/common';
import { CredentialCheck, invalidCredentials } from './credential-check.js';
import { toLoginResult, type LoginResult } from './dto/login-result.js';
import {
  SessionIssuer,
  type ClientInfo,
  type DeviceInput,
} from './session-issuer.js';

@Injectable()
export class LoginUseCase {
  constructor(
    private readonly credentials: CredentialCheck,
    private readonly sessionIssuer: SessionIssuer,
  ) {}

  async execute(input: {
    email: string;
    authProof: string;
    device: DeviceInput;
    client: ClientInfo;
  }): Promise<LoginResult> {
    const user = await this.credentials.verify(input.email, input.authProof);
    // Um Hub só abre sessão de pessoa pela rota dele (`POST /hub/user-sessions`, sessão presa ao Hub). Aqui a
    // plataforma `hub` dá o mesmo erro da senha errada, depois da mesma verificação (sem oráculo).
    if (!user || input.device.platform === 'hub') throw invalidCredentials();
    const tokens = await this.sessionIssuer.start(
      user,
      input.device,
      input.client,
      new Date(),
    );
    return toLoginResult(user, tokens);
  }
}
