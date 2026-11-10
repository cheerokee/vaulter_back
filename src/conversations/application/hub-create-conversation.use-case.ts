import { Injectable } from '@nestjs/common';
import { HubAccess } from '../../hubs/application/hub-access.js';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import {
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceAccess } from '../../spaces/application/space-access.js';
import { SpaceStorage } from '../../spaces/application/space-storage.js';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import {
  assertSpaceFits,
  conversationIdConflict,
  executorInvalid,
  participantNotSpaceMember,
} from '../domain/conversation-errors.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationParticipantRepository } from '../domain/conversation-participant.repository.js';
import {
  assertInitialState,
  type ConversationState,
} from '../domain/conversation-state.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { Conversation } from '../domain/conversation.js';
import { assertParticipantCapacity } from '../domain/participation-rules.js';
import { assertWrappedConversationKey } from '../domain/wrapped-conversation-key.js';
import { ConversationExecutors } from './conversation-executors.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

export type HubCreateConversationInput = {
  id: string;
  spaceId: string;
  /** The person the conversation is opened for: owner and first participant. */
  ownerUserId: string;
  /** Only `aviso` (the copilot's notice, the default); else 422 `conversation-state-invalid`. */
  state?: ConversationState;
  encryptedHeader: string;
  /** Version 1 sealed for each participant: the owner and, when it is someone else, the hub owner. */
  grants: { userId: string; wrappedKey: string }[];
  /** Version 1 sealed for the hub itself (the executor). */
  hubWrappedKey: string;
};

// O Hub abre um assunto (o "aviso" do copiloto, spec §4.1) em nome de uma pessoa, sendo ele mesmo o executor. A
// pessoa precisa ter papel no Hub (`HubAccess.hasAccess`) e ser membro do espaço; pela regra do executor, o dono do
// Hub é essa pessoa ou também participa (vem nas `grants`). Todos os participantes são membros do espaço (422
// `participant-not-space-member`). Espaço que não está no Hub (ou vínculo não aprovado), dono do Hub fora das
// `grants`, ou pessoa sem papel no Hub: 422 `executor-invalid`. O RLS deixa o Hub inserir com qualquer dono (policy
// `executor_hub_id = app.hub_id`): estas regras SÃO a trava. Reenviar o mesmo `id` devolve o mesmo assunto.
// Locks: Hub -> vínculo -> hub_space (FOR SHARE) -> espaço (FOR SHARE) -> o assunto novo.
@Injectable()
export class HubCreateConversationUseCase {
  constructor(
    private readonly hubs: HubDirectory,
    private readonly hubAccess: HubAccess,
    private readonly spaces: SpaceAccess,
    private readonly executors: ConversationExecutors,
    private readonly conversations: ConversationRepository,
    private readonly participants: ConversationParticipantRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly views: ConversationViews,
    private readonly uow: UnitOfWork,
    private readonly spaceStorage: SpaceStorage,
    private readonly usage: SpaceStorageUsage,
  ) {}

  execute(
    hub: HubAuthContext,
    input: HubCreateConversationInput,
  ): Promise<{ view: ConversationView; created: boolean }> {
    const { hubId } = hub;
    const { spaceId, ownerUserId } = input;
    assertWrappedConversationKey(input.hubWrappedKey);
    for (const g of input.grants) assertWrappedConversationKey(g.wrappedKey);
    const participantIds = input.grants.map((g) => g.userId);
    if (new Set(participantIds).size !== participantIds.length) {
      throw new DomainValidationError(
        'duplicate-participant',
        'Each participant appears once.',
      );
    }
    if (!participantIds.includes(ownerUserId)) {
      throw new DomainValidationError(
        'conversation-owner-not-participant',
        'The owner must be a participant of the conversation.',
      );
    }
    assertParticipantCapacity(0, participantIds.length);
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId });
      const organizationId = await this.hubs.installedSpaceOrganization(
        hubId,
        spaceId,
      );
      if (!organizationId) throw executorInvalid();
      const scope: ConversationScope = {
        organizationId,
        actor: { kind: 'hub', hubId },
      };
      const existing = await this.conversations.findById(scope, input.id, {
        withDeleted: true,
      });
      if (existing) {
        if (existing.spaceId !== spaceId || existing.deletedAt) {
          throw conversationIdConflict();
        }
        return { view: await this.views.of(scope, existing), created: false };
      }
      const conversation = Conversation.create({
        id: input.id,
        organizationId,
        spaceId,
        createdByUserId: ownerUserId,
        ownerUserId,
        executorHubId: hubId,
        state: assertInitialState('hub', input.state ?? 'aviso'),
        encryptedHeader: input.encryptedHeader,
        now: new Date(),
      });
      await this.executors.lockEligible({
        hubId,
        organizationId,
        spaceId,
        participantUserIds: participantIds,
      });
      if (!(await this.hubAccess.hasAccess(hubId, ownerUserId))) {
        throw executorInvalid();
      }
      // A trava do espaço vem pela pessoa (membro): quem não é membro não trava nada (422).
      let lockedOrg: string;
      try {
        const { space } = await this.spaces.lockAsMember(
          spaceId,
          ownerUserId,
          'memory.read',
          undefined,
          'share',
        );
        lockedOrg = space.organizationId;
      } catch (e) {
        if (e instanceof NotFoundError) throw participantNotSpaceMember();
        throw e;
      }
      if (lockedOrg !== organizationId) throw participantNotSpaceMember();
      for (const userId of participantIds) {
        if (
          !(await this.spaces.isSpaceMember(organizationId, spaceId, userId))
        ) {
          throw participantNotSpaceMember();
        }
      }

      // The same row FOR SHARE again (no new lock): the quota for the header bytes.
      const quotaBytes = await this.spaceStorage.lockQuota(
        organizationId,
        spaceId,
      );
      if (quotaBytes === null) throw participantNotSpaceMember();
      await this.conversations.create(scope, conversation);
      // Os outros entram 1 ms depois do dono: na sucessão do dono (mais antigo primeiro), o dono vem antes.
      const joinedAt = new Date(
        (conversation.createdAt ?? new Date()).getTime() + 1,
      );
      for (const userId of participantIds) {
        if (userId !== ownerUserId) {
          await this.participants.add(scope, conversation.id, userId, joinedAt);
        }
      }
      for (const g of input.grants) {
        await this.grants.put(scope, conversation.id, {
          keyVersion: 1,
          recipient: { kind: 'user', userId: g.userId },
          wrappedKey: g.wrappedKey,
        });
      }
      await this.grants.put(scope, conversation.id, {
        keyVersion: 1,
        recipient: { kind: 'hub', hubId },
        wrappedKey: input.hubWrappedKey,
      });
      // The header counts in the space usage (trigger); checked AFTER writing, like a message.
      assertSpaceFits(
        quotaBytes,
        await this.usage.usedBytes(organizationId, spaceId),
      );
      return {
        view: await this.views.reload(scope, conversation.id),
        created: true,
      };
    });
  }
}
