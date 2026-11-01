import { Injectable } from '@nestjs/common';
import { HubTokenService } from '../../identity/application/hub-token-service.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { HubRepository } from '../domain/hub.repository.js';
import { invalidHubToken } from './hub-auth-errors.js';

/** The authenticated Hub of a request (set by the hub token guard). */
export type HubAuthContext = { hubId: string };

// A cada requisição de rota de Hub: assinatura, `typ: hub+jwt`, emissor, audiência e validade (HubTokenService),
// e o Hub ainda existe e não foi desregistrado (lido no contexto do próprio Hub). Toda falha: 401
// `invalid-hub-token`. Um token de usuário nunca passa (`typ` diferente).
@Injectable()
export class AuthenticateHubTokenUseCase {
  constructor(
    private readonly tokens: HubTokenService,
    private readonly hubs: HubRepository,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    token: string,
    now: Date = new Date(),
  ): Promise<HubAuthContext> {
    // verify já lança UnauthenticatedError('invalid-hub-token') para qualquer falha do token.
    const { hubId } = await this.tokens.verify(token, now);
    const hub = await this.uow.withContext({ hubId }, () =>
      this.hubs.findById(hubId),
    );
    if (!hub || hub.isDeregistered) throw invalidHubToken();
    return { hubId };
  }
}
