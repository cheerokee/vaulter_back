import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { newId } from '../../shared/domain/id.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { AuthChallengeRepository } from '../domain/auth-challenge.repository.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubCodeHasher } from './ports/hub-code-hasher.js';

export const HUB_CHALLENGE_TTL_MS = 60 * 1000;

export type HubChallengeResult = {
  /** 32 random bytes, base64url: single use, valid for 60 s. Only its hash is stored. */
  challenge: string;
  expiresAt: Date;
};

// Desafio da autenticação do Hub (rota pública). Sem oráculo: para um Hub inexistente, desregistrado ou um id
// malformado sai um desafio igual (mesmo formato e validade), gravado com hub_id nulo, que nunca valida
// (`consume` exige hub_id = o Hub). Os dois caminhos fazem o mesmo trabalho: uma leitura do Hub e um INSERT.
@Injectable()
export class IssueHubChallengeUseCase {
  constructor(
    private readonly hubs: HubRepository,
    private readonly challenges: AuthChallengeRepository,
    private readonly codes: HubCodeHasher,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(hubId: string): Promise<HubChallengeResult> {
    const now = new Date();
    const challenge = this.codes.newChallenge();
    const challengeHash = await this.codes.hashChallenge(challenge);
    const expiresAt = new Date(now.getTime() + HUB_CHALLENGE_TTL_MS);
    await this.uow.run(async () => {
      const wellFormed = typeof hubId === 'string' && validate(hubId);
      // O Hub só se enxerga no próprio contexto (`app.hub_id`); id malformado nem entra no contexto (cast).
      if (wellFormed) await this.uow.setContext({ hubId });
      const hub = wellFormed ? await this.hubs.findById(hubId) : null;
      await this.challenges.create({
        id: newId(),
        hubId: hub && !hub.isDeregistered ? hub.id : null,
        challengeHash,
        expiresAt,
        usedAt: null,
      });
    });
    return { challenge, expiresAt };
  }
}
