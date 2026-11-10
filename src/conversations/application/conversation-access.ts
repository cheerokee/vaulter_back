import { Injectable } from '@nestjs/common';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { SpaceAccess } from '../../spaces/application/space-access.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { conversationNotFound } from '../domain/conversation-errors.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import type { Conversation } from '../domain/conversation.js';

export type ScopedConversation = {
  scope: ConversationScope;
  conversation: Conversation;
};

// Como um caso de uso chega a um assunto (e ao escopo de RLS dele):
// - pessoa (rotas `/spaces/:spaceId/conversations/...`): a organização vem do espaço, pelo `SpaceAccess` (só um
//   membro do espaço resolve). Quem não é membro do espaço, espaço de outra organização, assunto de outro espaço,
//   inexistente ou de que a pessoa não participa: SEMPRE o mesmo 404 `conversation-not-found`. Quem sai do espaço sai
//   dos assuntos dele (gancho `SpaceMemberLeftHooks`), então "membro do espaço" nunca nega a um participante.
// - Hub (rotas `/hub/conversations/...`): procura o assunto nas organizações com vínculo aprovado (no contexto do
//   próprio Hub, o RLS só mostra onde ele é executor). Não achou: o mesmo 404.
// `lock*` rodam DENTRO do UnitOfWork.run e travam a linha do assunto (`FOR UPDATE`), que vem DEPOIS de Hub, vínculo,
// hub_space e espaço na ordem global de locks.
@Injectable()
export class ConversationAccess {
  constructor(
    private readonly spaces: SpaceAccess,
    private readonly hubs: HubDirectory,
    private readonly conversations: ConversationRepository,
  ) {}

  /** The person's scope in the space's organization (404 `conversation-not-found` for a non-member of the space). */
  async userScope(spaceId: string, userId: string): Promise<ConversationScope> {
    try {
      const { space } = await this.spaces.requireSpaceMember(spaceId, userId);
      return {
        organizationId: space.organizationId,
        actor: { kind: 'user', userId },
      };
    } catch (e) {
      if (e instanceof NotFoundError) throw conversationNotFound();
      throw e;
    }
  }

  async findForUser(
    spaceId: string,
    conversationId: string,
    userId: string,
  ): Promise<ScopedConversation> {
    const scope = await this.userScope(spaceId, userId);
    const conversation = await this.conversations.findById(
      scope,
      conversationId,
    );
    return { scope, conversation: inSpace(conversation, spaceId) };
  }

  async lockForUser(
    spaceId: string,
    conversationId: string,
    userId: string,
  ): Promise<ScopedConversation> {
    const scope = await this.userScope(spaceId, userId);
    return {
      scope,
      conversation: await this.lock(scope, conversationId, spaceId),
    };
  }

  /** Locks in a scope already resolved (the conversation must still be in `spaceId`); `share` = `FOR SHARE`. */
  async lock(
    scope: ConversationScope,
    conversationId: string,
    spaceId: string,
    mode: 'update' | 'share' = 'update',
  ): Promise<Conversation> {
    return inSpace(
      await this.conversations.lockById(scope, conversationId, mode),
      spaceId,
    );
  }

  async findForHub(
    hubId: string,
    conversationId: string,
  ): Promise<ScopedConversation> {
    for (const organizationId of await this.hubs.approvedOrganizationIds(
      hubId,
    )) {
      const scope: ConversationScope = {
        organizationId,
        actor: { kind: 'hub', hubId },
      };
      const conversation = await this.conversations.findById(
        scope,
        conversationId,
      );
      if (conversation) return { scope, conversation };
    }
    throw conversationNotFound();
  }

  async lockForHub(
    hubId: string,
    conversationId: string,
  ): Promise<ScopedConversation> {
    const { scope } = await this.findForHub(hubId, conversationId);
    const conversation = await this.conversations.lockById(
      scope,
      conversationId,
    );
    if (!conversation) throw conversationNotFound();
    return { scope, conversation };
  }
}

function inSpace(c: Conversation | null, spaceId: string): Conversation {
  if (!c || c.spaceId !== spaceId) throw conversationNotFound();
  return c;
}
