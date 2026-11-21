import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { HubDirectory } from '../../hubs/application/hub-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import {
  brainStepNotOwned,
  conversationNotFound,
} from '../domain/conversation-errors.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import type { ConversationMessage } from '../domain/conversation-message.js';
import { requireAgentTurnMessage } from './agent-turn-rules.js';
import { ConversationAccess } from './conversation-access.js';
import { HubConversationScope } from './hub-conversation-scope.js';

/** The agent's turn on one message (only ids and a flag): what the brain step works from. */
export type AgentTurnView = {
  organizationId: string;
  spaceId: string;
  conversationId: string;
  /** The person's message the agent acked and is answering. */
  messageId: string;
  /** The `pc` hub holding the turn (the conversation's executor): whose tool catalog the brain step reads. */
  hubId: string;
  /** Its RECORDED author (never what the agent claims): PC tools only when this is the hub owner (spec pc-agent §5.2). */
  authorUserId: string;
  hubOwnerUserId: string;
  /** The conversation has the cloud reserve on (server copies of the key: document tools). */
  cloudReserve: boolean;
};

/**
 * Exported port (for the `cloud` brain step, spec pc-agent §5.3): whether a `pc` hub (the agent) holds its turn on a
 * person's message, and the renewal of its ack lease. In this order:
 * 1. the hub is the conversation's executor, in an organization with an approved link (`HubConversationScope`), else
 *    404 `conversation-not-found`;
 * 2. the message is a live person's message of the conversation, acknowledged BY THIS HUB, with its lease
 *    (`AGENT_ACK_LEASE_MS`) still running by the database clock, and not answered by it (a hub message whose
 *    `answersMessageId` is this message: `requireAgentTurnMessage`), else 409 `brain-step-not-owned`. A lease past its end is over even
 *    before the sweep requeues the message: expiry never depends on when the sweep runs.
 * `requireTurn` only reads (no lock; inside the caller's unit of work when there is one, else its own short one).
 * `renewLease` locks the conversation `FOR NO KEY UPDATE` (like the ack) and re-checks everything under it. Never
 * reached by an appliance: the routes are `@PcHubOnly()` (an appliance ack has no lease, so it would be 409 anyway).
 */
@Injectable()
export class AgentTurn {
  constructor(
    private readonly scope: HubConversationScope,
    private readonly access: ConversationAccess,
    private readonly messages: ConversationMessageRepository,
    private readonly hubs: HubDirectory,
    private readonly uow: UnitOfWork,
  ) {}

  requireTurn(
    hubId: string,
    conversationId: string,
    messageId: string,
  ): Promise<AgentTurnView> {
    return this.uow.run(async () => {
      const { scope, conversation } = await this.scope.executedBy(
        hubId,
        conversationId,
      );
      const message = await this.ownedMessage(
        scope,
        hubId,
        conversationId,
        messageId,
      );
      const hubOwnerUserId = await this.hubs.ownerOf(hubId);
      if (!hubOwnerUserId) throw conversationNotFound();
      return {
        organizationId: conversation.organizationId,
        spaceId: conversation.spaceId,
        conversationId: conversation.id,
        messageId: message.id,
        hubId,
        authorUserId: message.authorUserId!,
        hubOwnerUserId,
        cloudReserve: conversation.cloudReserve,
      };
    });
  }

  renewLease(
    hubId: string,
    conversationId: string,
    messageId: string,
  ): Promise<{ leaseUntil: Date }> {
    if (!validate(hubId) || !validate(conversationId)) {
      return Promise.reject(conversationNotFound());
    }
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId });
      const { scope, conversation } = await this.access.lockForHub(
        hubId,
        conversationId,
        'no-key-update',
      );
      if (!conversation.isExecutor(hubId)) throw conversationNotFound();
      const message = await this.ownedMessage(
        scope,
        hubId,
        conversationId,
        messageId,
      );
      const leaseUntil = message.renewAgentLease(
        await this.messages.databaseNow(),
      );
      await this.messages.save(scope, message);
      return { leaseUntil };
    });
  }

  /** The message is this hub's turn (rule 2 above), else 409 `brain-step-not-owned`. */
  private ownedMessage(
    scope: ConversationScope,
    hubId: string,
    conversationId: string,
    messageId: string,
  ): Promise<ConversationMessage> {
    if (!validate(messageId)) return Promise.reject(brainStepNotOwned());
    return requireAgentTurnMessage(
      this.messages,
      scope,
      hubId,
      conversationId,
      messageId,
    );
  }
}
