import { Injectable } from '@nestjs/common';
import { SessionRepository } from '../domain/session.repository.js';

// Exportado para o `hubs`: revogação das sessões presas a um Hub (motivo `hub_access_lost`, primeiro motivo vence),
// chamada dentro do unit of work de quem tira o acesso (tirar papel, desvincular, saída da organização, desregistro).
// Não decide nada: quem perdeu o acesso é o `hubs` que sabe. Sessões sem Hub (celular) nunca são tocadas.
@Injectable()
export class HubBoundSessions {
  constructor(private readonly sessions: SessionRepository) {}

  /** People with a live session bound to the hub (the candidates of a revocation sweep), in id order. */
  activeUserIdsOnHub(hubId: string): Promise<string[]> {
    return this.sessions.activeUserIdsOnHub(hubId);
  }

  /** The person lost every role on the hub: their sessions bound to it end. */
  revokeAllForUserOnHub(
    userId: string,
    hubId: string,
    now: Date = new Date(),
  ): Promise<number> {
    return this.sessions.revokeAllForUserOnHub(
      userId,
      hubId,
      'hub_access_lost',
      now,
    );
  }

  /** The hub is gone (deregistered): every session bound to it ends. */
  revokeAllOnHub(hubId: string, now: Date = new Date()): Promise<number> {
    return this.sessions.revokeAllOnHub(hubId, 'hub_access_lost', now);
  }
}
