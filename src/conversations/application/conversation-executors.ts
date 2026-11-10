import { Injectable } from '@nestjs/common';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import { assertExecutorEligible } from '../domain/participation-rules.js';

// A regra do executor (spec §4.1) contra o estado do `hubs`, pelo que ele exporta (`HubDirectory`): Hub ativo,
// vínculo aprovado da organização do espaço, `hub_space` vivo e o dono do Hub entre os participantes. A Sala não é
// exigida (a chave do assunto chega por cópia própria).
@Injectable()
export class ConversationExecutors {
  constructor(private readonly hubs: HubDirectory) {}

  /**
   * MUST run inside `UnitOfWork.run`, BEFORE locking the space or the conversation (lock order: Hub -> link ->
   * hub_space FOR SHARE, then space, then conversation). 422 `executor-invalid` when the hub cannot execute work of
   * the space or its owner does not participate. Returns the hub owner.
   */
  async lockEligible(input: {
    hubId: string;
    organizationId: string;
    spaceId: string;
    participantUserIds: readonly string[];
  }): Promise<string> {
    const candidate = await this.hubs.lockExecutorCandidate(
      input.hubId,
      input.organizationId,
      input.spaceId,
    );
    assertExecutorEligible({
      hubOwnerUserId: candidate?.ownerUserId ?? null,
      participantUserIds: input.participantUserIds,
      spaceInstalled: candidate !== null,
    });
    return candidate!.ownerUserId;
  }

  /** Owner of the current executor (no lock), or null without one. */
  ownerOf(hubId: string | null): Promise<string | null> {
    return hubId ? this.hubs.ownerOf(hubId) : Promise.resolve(null);
  }
}
