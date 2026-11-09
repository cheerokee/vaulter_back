import { Injectable } from '@nestjs/common';
import { newId } from '../../shared/domain/id.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { CredentialCheck, invalidCredentials } from './credential-check.js';
import { toLoginResult, type LoginResult } from './dto/login-result.js';
import { SessionIssuer, type ClientInfo } from './session-issuer.js';

/**
 * Who may log in on the hub, decided by the caller (the `hubs` module: the identity never imports it). Runs inside
 * the transaction that creates the session, so the caller can lock what its revocations lock.
 */
export type HubLoginGate = (userId: string) => Promise<boolean>;

// Exportado para o `hubs` (spec storage-backup §4.7): login de uma pessoa feito pelo Hub, com sessão presa a ele
// (`hub_id`, plataforma `hub`). A checagem de papel vem do `hubs` (`isAllowed`); senha errada, e-mail desconhecido e
// pessoa sem papel no Hub dão o MESMO `invalid-credentials`, e fazem o mesmo trabalho: a verificação da senha (uma
// Argon2id, fora da transação) e a checagem de papel (dentro dela; para quem errou a senha, com um id aleatório, que
// nunca tem papel). A checagem e a criação da sessão ficam numa transação só: o `hubs` trava ali o que as revogações
// dele travam, e uma revogação concorrente ou vê a sessão nova ou é vista pela checagem.
@Injectable()
export class HubSessionIssuer {
  constructor(
    private readonly credentials: CredentialCheck,
    private readonly sessionIssuer: SessionIssuer,
    private readonly uow: UnitOfWork,
  ) {}

  async loginOnHub(input: {
    hubId: string;
    email: string;
    authProof: string;
    device: { name: string };
    client: ClientInfo;
    isAllowed: HubLoginGate;
  }): Promise<LoginResult> {
    const user = await this.credentials.verify(input.email, input.authProof);
    return this.uow.run(async () => {
      const allowed = await input.isAllowed(user ? user.id : newId());
      if (!user || !allowed) throw invalidCredentials();
      const tokens = await this.sessionIssuer.start(
        user,
        { name: input.device.name, platform: 'hub' },
        input.client,
        new Date(),
        input.hubId,
      );
      return toLoginResult(user, tokens);
    });
  }
}
