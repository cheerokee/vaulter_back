import { Injectable } from '@nestjs/common';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { conversationNotFound } from '../domain/conversation-errors.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationParticipantRepository } from '../domain/conversation-participant.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import type { Conversation } from '../domain/conversation.js';
import type { ConversationView } from './dto/conversation-view.js';

/** Builds the view in the caller's scope: participants and the caller's own copies. */
@Injectable()
export class ConversationViews {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly participants: ConversationParticipantRepository,
    private readonly grants: ConversationKeyGrantRepository,
  ) {}

  async of(
    scope: ConversationScope,
    c: Conversation,
  ): Promise<ConversationView> {
    const p = c.snapshot();
    return {
      id: c.id,
      organizationId: p.organizationId,
      spaceId: p.spaceId,
      createdByUserId: p.createdByUserId,
      ownerUserId: p.ownerUserId,
      executorHubId: p.executorHubId,
      state: p.state,
      lastMessageAt: p.lastMessageAt,
      currentKeyVersion: p.currentKeyVersion,
      keyRotationRequired: p.keyRotationRequired,
      encryptedHeader: p.encryptedHeader,
      headerKeyVersion: p.headerKeyVersion,
      movedFromConversationId: p.movedFromConversationId,
      cloudReserve: p.cloudReserve,
      cloudReserveDeclined: p.cloudReserveDeclined,
      cloudAnswer: p.cloudAnswer,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt ?? null,
      participants: await this.participants.listLive(scope, c.id),
      keys: await this.grants.listFor(scope, c.id, scope.actor),
    };
  }

  /** Re-reads after a write (fresh `updatedAt` and participants). */
  async reload(
    scope: ConversationScope,
    conversationId: string,
  ): Promise<ConversationView> {
    const c = await this.conversations.findById(scope, conversationId);
    if (!c) throw conversationNotFound();
    return this.of(scope, c);
  }
}
