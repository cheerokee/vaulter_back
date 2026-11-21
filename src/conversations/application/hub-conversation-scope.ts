import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { conversationNotFound } from '../domain/conversation-errors.js';
import { ConversationAccess } from './conversation-access.js';

export type HubConversationOrigin = {
  organizationId: string;
  spaceId: string;
};

/**
 * Exported port (the only part of `conversations` the `agents` module may import): where a conversation lives, as a Hub
 * sees it. Resolves the (organization, space) of the conversation ONLY when the Hub is its executor and the Hub is
 * linked (approved) to the organization; any other case (unknown id, another executor, link lost, tombstoned
 * conversation) is the same 404 `conversation-not-found`. Read only, no lock; it does not authorize anything beyond
 * "this Hub executes this conversation". Runs in the ambient unit of work when there is one.
 */
@Injectable()
export class HubConversationScope {
  constructor(private readonly access: ConversationAccess) {}

  async organizationOf(
    hubId: string,
    conversationId: string,
  ): Promise<HubConversationOrigin> {
    if (!validate(hubId) || !validate(conversationId)) {
      throw conversationNotFound();
    }
    const { conversation } = await this.access.findForHub(
      hubId,
      conversationId,
    );
    if (!conversation.isExecutor(hubId)) throw conversationNotFound();
    return {
      organizationId: conversation.organizationId,
      spaceId: conversation.spaceId,
    };
  }
}
