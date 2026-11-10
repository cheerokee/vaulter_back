import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

// Um assunto, para quem participa (pessoa) ou para o executor (Hub): metadado, participantes e as cópias da chave de
// quem pede. Qualquer outro: 404 `conversation-not-found`. A lista e as mudanças vêm pela sincronização (Task 6).
@Injectable()
export class GetConversationUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly views: ConversationViews,
  ) {}

  async byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
  ): Promise<ConversationView> {
    const { scope, conversation } = await this.access.findForUser(
      spaceId,
      conversationId,
      actor.userId,
    );
    return this.views.of(scope, conversation);
  }

  async byHub(
    hub: HubAuthContext,
    conversationId: string,
  ): Promise<ConversationView> {
    const { scope, conversation } = await this.access.findForHub(
      hub.hubId,
      conversationId,
    );
    return this.views.of(scope, conversation);
  }
}
