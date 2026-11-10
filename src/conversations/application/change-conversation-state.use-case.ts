import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { ConversationState } from '../domain/conversation-state.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import {
  ConversationAccess,
  type ScopedConversation,
} from './conversation-access.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

// Estado do assunto (spec §4.1, decisão do controlador): arquivar/reabrir (de ou para `arquivado`) é do DONO; os
// estados de trabalho são do EXECUTOR (o copiloto relata o trabalho). Qualquer outro: 403 `not-conversation-owner`
// (regra em `Conversation.changeState`). Mesmo estado de novo: nada muda. Lock: só o assunto.
@Injectable()
export class ChangeConversationStateUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly conversations: ConversationRepository,
    private readonly views: ConversationViews,
    private readonly uow: UnitOfWork,
  ) {}

  byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    state: ConversationState,
  ): Promise<ConversationView> {
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      return this.apply(
        await this.access.lockForUser(spaceId, conversationId, actor.userId),
        state,
      );
    });
  }

  byHub(
    hub: HubAuthContext,
    conversationId: string,
    state: ConversationState,
  ): Promise<ConversationView> {
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      return this.apply(
        await this.access.lockForHub(hub.hubId, conversationId),
        state,
      );
    });
  }

  private async apply(
    { scope, conversation }: ScopedConversation,
    state: ConversationState,
  ): Promise<ConversationView> {
    const before = conversation.state;
    conversation.changeState(scope.actor, state);
    if (conversation.state !== before) {
      await this.conversations.save(scope, conversation);
    }
    return this.views.reload(scope, conversation.id);
  }
}
