import { Injectable } from '@nestjs/common';
import type { LoginResult } from '../../identity/application/dto/login-result.js';
import { HubSessionIssuer } from '../../identity/application/hub-session-issuer.js';
import type { ClientInfo } from '../../identity/application/session-issuer.js';
import type { HubAuthContext } from './authenticate-hub-token.use-case.js';
import { HubPersonSessions } from './hub-person-sessions.js';

// Login de uma pessoa pelo Hub (`POST /hub/user-sessions`, token de Hub; spec storage-backup §4.7): o `identity`
// confere a senha e abre a sessão presa ao Hub; daqui vem só a checagem de papel. Quem não tem papel no Hub recebe o
// mesmo `invalid-credentials` da senha errada (sem oráculo). O Hub também confere localmente; o backend é a segunda
// trava.
@Injectable()
export class LoginPersonOnHubUseCase {
  constructor(
    private readonly issuer: HubSessionIssuer,
    private readonly personSessions: HubPersonSessions,
  ) {}

  execute(
    hub: HubAuthContext,
    input: {
      email: string;
      authProof: string;
      device: { name: string };
      client: ClientInfo;
    },
  ): Promise<LoginResult> {
    const { hubId } = hub;
    return this.issuer.loginOnHub({
      hubId,
      ...input,
      isAllowed: (userId) => this.personSessions.isAllowed(hubId, userId),
    });
  }
}
