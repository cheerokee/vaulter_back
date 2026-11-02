import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { HubTokenService } from '../../identity/application/hub-token-service.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { AuthChallengeRepository } from '../domain/auth-challenge.repository.js';
import { HUB_LABELS } from '../domain/hub-signed-message.js';
import { HubRepository } from '../domain/hub.repository.js';
import { hubAuthFailed } from './hub-auth-errors.js';
import { HubCodeHasher } from './ports/hub-code-hasher.js';
import { HubSignatureVerifier } from './ports/hub-signature-verifier.js';

export type IssueHubTokenInput = {
  hubId: string;
  /** The challenge from `POST /hub-auth/challenge`. */
  challenge: string;
  /** Ed25519 over `hub-auth-v1` and `{ hubId, challenge }`. */
  signature: string;
};

export type HubTokenResult = { token: string; expiresAt: Date };

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

// Troca um desafio assinado por um token de Hub (rota pública). Toda falha é o MESMO 401 `hub-auth-failed`. Na
// transação, no contexto do próprio Hub: o Hub existe e não foi desregistrado, a assinatura confere com a chave
// dele, e o desafio é consumido de forma atômica (uso único: um replay ou duas chamadas concorrentes, só uma
// vence); só então `last_seen_at`. O token (JWT `hub+jwt`) é assinado depois do COMMIT.
@Injectable()
export class IssueHubTokenUseCase {
  constructor(
    private readonly hubs: HubRepository,
    private readonly challenges: AuthChallengeRepository,
    private readonly verifier: HubSignatureVerifier,
    private readonly codes: HubCodeHasher,
    private readonly tokens: HubTokenService,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(input: IssueHubTokenInput): Promise<HubTokenResult> {
    const { hubId, challenge, signature } = input;
    if (
      typeof hubId !== 'string' ||
      !validate(hubId) ||
      typeof challenge !== 'string' ||
      !CHALLENGE.test(challenge)
    ) {
      throw hubAuthFailed();
    }
    const now = new Date();
    const challengeHash = await this.codes.hashChallenge(challenge);
    await this.uow.run(async () => {
      await this.uow.setContext({ hubId });
      const hub = await this.hubs.findById(hubId);
      const active = hub !== null && !hub.isDeregistered;
      const signed = await this.verifier.verify(
        HUB_LABELS.auth,
        { hubId, challenge },
        signature,
        active ? hub.signingPublicKey : this.verifier.decoyPublicKey(),
      );
      if (!active || !signed) throw hubAuthFailed();
      if (!(await this.challenges.consume(hubId, challengeHash, now))) {
        throw hubAuthFailed();
      }
      hub.touch(now);
      await this.hubs.save(hub);
    });
    return this.tokens.issue(hubId, now);
  }
}
