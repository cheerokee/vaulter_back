import { Injectable } from '@nestjs/common';
import { HubBoundSessions } from '../../identity/application/hub-bound-sessions.js';
import { HubRepository } from '../domain/hub.repository.js';
import { HubAccess } from './hub-access.js';

// Sessões de pessoas abertas pelo Hub (spec storage-backup §4.7): quem pode entrar e quem perdeu o acesso. O
// `identity` guarda as sessões e só revoga; quem tem papel no Hub é decidido aqui (`HubAccess.hasAccess`: dono,
// papel explícito ou `hub_user` implícito por organização com vínculo aprovado).
//
// Concorrência login x revogação (uma transação cada): o login segura o Hub FOR SHARE e o advisory lock das sessões
// do Hub em modo COMPARTILHADO da checagem de papel até o COMMIT da sessão; a varredura de revogação pega o mesmo
// advisory EXCLUSIVO, por último (depois de tirar o acesso), antes de ler as sessões do Hub. Ou a varredura espera o
// login terminar e vê a sessão nova, ou o login espera a varredura e a checagem (comando novo, READ COMMITTED) já vê
// o acesso tirado. O desregistro não varre: trava o Hub FOR UPDATE (o login espera, e depois acha o Hub com lápide)
// e revoga todas as sessões do Hub. Sem ciclo de espera: o login só trava Hub (FOR SHARE) e o advisory, nessa ordem;
// a varredura pega o advisory por último e, com vários Hubs, em ordem de id.
@Injectable()
export class HubPersonSessions {
  constructor(
    private readonly hubs: HubRepository,
    private readonly access: HubAccess,
    private readonly sessions: HubBoundSessions,
  ) {}

  /**
   * The gate of `HubSessionIssuer.loginOnHub`: runs inside its transaction. Locks the hub (FOR SHARE; a missing or
   * deregistered hub is false) and the hub's person sessions (shared), then checks the role.
   */
  async isAllowed(hubId: string, userId: string): Promise<boolean> {
    if (!(await this.hubs.lockForShare(hubId))) return false;
    await this.hubs.lockPersonSessions(hubId, 'shared');
    return this.access.hasAccess(hubId, userId);
  }

  /**
   * Revocation sweep, inside the caller's unit of work and AFTER the access change: on each hub (id order), every
   * person with a live session bound to it who no longer has any role there loses those sessions. Sessions of other
   * hubs and of other devices are never touched.
   */
  async revokeLostAccess(hubIds: Iterable<string>): Promise<void> {
    const now = new Date();
    for (const hubId of [...new Set(hubIds)].sort()) {
      await this.hubs.lockPersonSessions(hubId, 'exclusive');
      for (const userId of await this.sessions.activeUserIdsOnHub(hubId)) {
        if (await this.access.hasAccess(hubId, userId)) continue;
        await this.sessions.revokeAllForUserOnHub(userId, hubId, now);
      }
    }
  }

  /** Deregistration: every session bound to the hub ends (the caller holds the hub FOR UPDATE). */
  async revokeAll(hubId: string): Promise<void> {
    await this.sessions.revokeAllOnHub(hubId);
  }
}
