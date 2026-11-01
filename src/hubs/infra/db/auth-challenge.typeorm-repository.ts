import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import {
  AuthChallengeRepository,
  type AuthChallenge,
} from '../../domain/auth-challenge.repository.js';
import { updatedRows } from './db-helpers.js';
import { HubAuthChallengeTypeormEntity } from './hub-auth-challenge.entity.js';

type ChallengeRow = {
  id: string;
  hub_id: string | null;
  challenge_hash: string;
  expires_at: Date;
  used_at: Date | null;
};

// Tabela só do backend (sem RLS): alcançada só pelo hash do desafio (e o id do Hub que o apresenta).
@Injectable()
export class AuthChallengeTypeormRepository extends AuthChallengeRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async create(challenge: AuthChallenge): Promise<void> {
    await currentManager(this.dataSource)
      .getRepository(HubAuthChallengeTypeormEntity)
      .insert({
        id: challenge.id,
        hubId: challenge.hubId,
        challengeHash: challenge.challengeHash,
        expiresAt: challenge.expiresAt,
        usedAt: challenge.usedAt,
      });
  }

  // Um UPDATE condicional com RETURNING: só uma chamada concorrente vence. O desafio falso (hub_id nulo) nunca
  // casa com `hub_id = $1`, então nunca valida.
  async consume(
    hubId: string,
    challengeHash: string,
    now: Date,
  ): Promise<AuthChallenge | null> {
    if (!validate(hubId)) return null;
    const rows = updatedRows<ChallengeRow>(
      await currentManager(this.dataSource).query(
        `UPDATE hub_auth_challenges SET used_at = $3, updated_at = now()
          WHERE hub_id = $1 AND challenge_hash = $2
            AND used_at IS NULL AND expires_at > $3 AND deleted_at IS NULL
         RETURNING id, hub_id, challenge_hash, expires_at, used_at`,
        [hubId, challengeHash, now],
      ),
    );
    const row = rows[0];
    return row
      ? {
          id: row.id,
          hubId: row.hub_id,
          challengeHash: row.challenge_hash,
          expiresAt: row.expires_at,
          usedAt: row.used_at,
        }
      : null;
  }
}
