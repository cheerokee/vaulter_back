import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceAccess } from '../../spaces/application/space-access.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { conversationIdConflict } from '../domain/conversation-errors.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import type { ConversationState } from '../domain/conversation-state.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { Conversation } from '../domain/conversation.js';
import { assertWrappedConversationKey } from '../domain/wrapped-conversation-key.js';
import { ConversationExecutors } from './conversation-executors.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

export type CreateConversationInput = {
  /** UUID v7 generated on the device (it is in the encryption AD). */
  id: string;
  /** Defaults to `na_fila` (a demand waiting for the executor). */
  state?: ConversationState;
  encryptedHeader: string;
  /** Version 1 sealed for the creator. */
  wrappedKey: string;
  /** Optional executor: a hub of the creator with the space installed, and version 1 sealed for it. */
  executor?: { hubId: string; wrappedKey: string } | null;
};

// Uma pessoa abre um assunto no espaço (spec §4.1): membro do espaço com `memory.read`, dona e única participante,
// com a versão 1 da chave trancada para si e, opcional, para o executor (um Hub DELA: o dono do Hub precisa
// participar, e na criação só ela participa; com o espaço instalado). Reenviar o mesmo `id` (falha de rede) devolve o
// mesmo assunto (`created: false`); um id já usado por outro assunto: 409 `conversation-id-conflict`.
// Locks: Hub -> vínculo -> hub_space (FOR SHARE, só com executor) -> espaço (FOR SHARE: uma saída do espaço
// concorrente espera e então leva o assunto junto) -> o assunto novo.
@Injectable()
export class CreateConversationUseCase {
  constructor(
    private readonly spaces: SpaceAccess,
    private readonly executors: ConversationExecutors,
    private readonly conversations: ConversationRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly views: ConversationViews,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    input: CreateConversationInput,
  ): Promise<{ view: ConversationView; created: boolean }> {
    const { userId } = actor;
    assertWrappedConversationKey(input.wrappedKey);
    if (input.executor) assertWrappedConversationKey(input.executor.wrappedKey);
    return this.uow.run(async () => {
      await this.uow.setContext({ userId });
      const { space } = await this.spaces.requireSpacePermission(
        spaceId,
        userId,
        'memory.read',
      );
      const scope: ConversationScope = {
        organizationId: space.organizationId,
        actor: { kind: 'user', userId },
      };
      const existing = await this.conversations.findById(scope, input.id, {
        withDeleted: true,
      });
      if (existing) {
        if (
          existing.spaceId !== spaceId ||
          existing.createdByUserId !== userId ||
          existing.deletedAt
        ) {
          throw conversationIdConflict();
        }
        return { view: await this.views.of(scope, existing), created: false };
      }
      const conversation = Conversation.create({
        id: input.id,
        organizationId: space.organizationId,
        spaceId,
        createdByUserId: userId,
        ownerUserId: userId,
        executorHubId: input.executor?.hubId ?? null,
        state: input.state ?? 'na_fila',
        encryptedHeader: input.encryptedHeader,
        now: new Date(),
      });
      if (input.executor) {
        await this.executors.lockEligible({
          hubId: input.executor.hubId,
          organizationId: space.organizationId,
          spaceId,
          participantUserIds: [userId],
        });
      }
      await this.spaces.lockAsMember(
        spaceId,
        userId,
        'memory.read',
        undefined,
        'share',
      );
      await this.conversations.create(scope, conversation);
      await this.grants.put(scope, conversation.id, {
        keyVersion: 1,
        recipient: { kind: 'user', userId },
        wrappedKey: input.wrappedKey,
      });
      if (input.executor) {
        await this.grants.put(scope, conversation.id, {
          keyVersion: 1,
          recipient: { kind: 'hub', hubId: input.executor.hubId },
          wrappedKey: input.executor.wrappedKey,
        });
      }
      return {
        view: await this.views.reload(scope, conversation.id),
        created: true,
      };
    });
  }
}
