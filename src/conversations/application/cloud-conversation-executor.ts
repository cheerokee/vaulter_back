import { Injectable } from '@nestjs/common';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceCloud } from '../../spaces/application/space-cloud.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import type { ConversationMessage } from '../domain/conversation-message.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import type { Conversation } from '../domain/conversation.js';
import type { ConversationState } from '../domain/conversation-state.js';
import type { MessageView } from './dto/message-view.js';
import {
  SendMessageUseCase,
  type SendMessageInput,
} from './send-message.use-case.js';

/** What the cloud sees of a conversation it may answer: metadata (the header stays encrypted). */
export type CloudConversationView = {
  id: string;
  organizationId: string;
  spaceId: string;
  ownerUserId: string;
  executorHubId: string | null;
  state: ConversationState;
  currentKeyVersion: number;
  keyRotationRequired: boolean;
  participantUserIds: readonly string[];
  encryptedHeader: string | null;
  headerKeyVersion: number | null;
  lastMessageAt: Date | null;
};

/** A message of the conversation's own history, still encrypted with the conversation key `keyVersion`. */
export type CloudMessageView = {
  id: string;
  authorUserId: string | null;
  authorHubId: string | null;
  authorCloud: boolean;
  keyVersion: number;
  encryptedBody: string;
  replacesMessageId: string | null;
  pending: boolean;
  sentAt: Date;
};

/** The conversation, the server's copies of its key (every live version) and its last messages, oldest first. */
export type CloudConversationRead = {
  conversation: CloudConversationView;
  serverKeyCopies: { keyVersion: number; wrappedKey: string }[];
  messages: CloudMessageView[];
};

/**
 * Result of the cloud's ack: `acked` = the cloud took it (it must answer). Idempotent for the cloud's own ack: a message
 * the cloud already acknowledged and has not answered yet (no cloud message after it) is `acked` again, so a job that
 * crashed between its ack and its answer resumes (the Hub's ack of it is 404: nobody else would answer it).
 * `taken` = the Hub took it, the cloud already answered it, or it was deleted: give up; `unavailable` = the conversation is out of the cloud's reach
 * (reserve off, space out of the active cloud, conversation gone) or its key must rotate first (the cloud cannot write
 * nor rotate): nothing changed, try again after a `CloudReservePendingHooks` signal.
 */
export type CloudAckResult = 'acked' | 'taken' | 'unavailable';

/** History bound for one read (the answering job reads the conversation's recent messages only). */
export const MAX_CLOUD_HISTORY_MESSAGES = 200;

// A nuvem como executor de reserva dos assuntos (spec active-cloud §4.3), para os jobs do `cloud` (exportado pela
// `application/`; o `cloud` nunca importa a `infra/` daqui e o `conversations` nunca importa o `cloud`).
// Tudo roda no contexto RLS da nuvem de UM espaço (`app.cloud_executor`, migration ConversationCloudReserve): só os
// assuntos vivos daquele espaço com `cloud_reserve`. Além do RLS, todo método confere que o espaço ainda está em
// `active_cloud` (`SpaceCloud`): leitura sem trava; ack e envio com o espaço FOR SHARE (o desligar trava FOR UPDATE:
// ou a resposta vem antes, ou o desligar vem antes e ela não acha nada). Fora disso: `null` / `unavailable` / 404.
// Nunca lê outro assunto que não o pedido: o histórico é só o do próprio assunto (Review Focus 5 do plano).
// Ordem de locks: espaço (FOR SHARE) -> assunto (FOR NO KEY UPDATE, como o envio e o ack do Hub, que se serializam com
// este: o primeiro ack vale, nunca os dois).
@Injectable()
export class CloudConversationExecutor {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly spaceCloud: SpaceCloud,
    private readonly sending: SendMessageUseCase,
    private readonly uow: UnitOfWork,
  ) {}

  /** Ids of the live conversations of the space with the cloud reserve (empty when the space is not active). */
  async conversationIds(
    organizationId: string,
    spaceId: string,
  ): Promise<string[]> {
    if (!(await this.isActive(organizationId, spaceId))) return [];
    return this.conversations.idsWithCloudReserve(
      scopeOf(organizationId, spaceId),
      spaceId,
    );
  }

  /**
   * The conversation, the server's key copies and its last `historyLimit` messages (≤ MAX_CLOUD_HISTORY_MESSAGES), or
   * null when out of the cloud's reach. One transaction, no lock.
   */
  async read(
    organizationId: string,
    spaceId: string,
    conversationId: string,
    historyLimit = MAX_CLOUD_HISTORY_MESSAGES,
  ): Promise<CloudConversationRead | null> {
    const limit = Math.max(
      1,
      Math.min(MAX_CLOUD_HISTORY_MESSAGES, Math.trunc(historyLimit)),
    );
    return this.uow.run(async () => {
      if (!(await this.isActive(organizationId, spaceId))) return null;
      const scope = scopeOf(organizationId, spaceId);
      const c = await this.conversations.findById(scope, conversationId);
      if (!c || c.spaceId !== spaceId || !c.isCloudExecutor()) return null;
      return {
        conversation: view(c),
        serverKeyCopies: await this.grants.listFor(scope, c.id, {
          kind: 'cloud',
        }),
        messages: (await this.messages.listRecent(scope, c.id, limit))
          .filter((m) => m.encryptedBody !== null)
          .map(messageOf),
      };
    });
  }

  /**
   * Inside the CALLER's unit of work: locks the space (FOR SHARE, still active) and the conversation (FOR NO KEY
   * UPDATE) as the cloud executor; null when out of reach. For a job that composes several steps in one transaction.
   */
  async lock(
    organizationId: string,
    spaceId: string,
    conversationId: string,
  ): Promise<CloudConversationView | null> {
    const c = await this.lockConversation(
      organizationId,
      spaceId,
      conversationId,
    );
    return c ? view(c) : null;
  }

  /**
   * The cloud takes a pending message (atomic with the Hub's ack: both lock the conversation FOR NO KEY UPDATE; the
   * first one wins, never both). See `CloudAckResult`.
   */
  ack(
    organizationId: string,
    spaceId: string,
    conversationId: string,
    messageId: string,
  ): Promise<CloudAckResult> {
    return this.uow.run(async () => {
      await this.uow.setContext({ cloudExecutorSpaceId: spaceId });
      const c = await this.lockConversation(
        organizationId,
        spaceId,
        conversationId,
      );
      if (!c || c.keyRotationRequired) return 'unavailable';
      const scope = scopeOf(organizationId, spaceId);
      const m = await this.messages.findById(scope, messageId, {
        withDeleted: true,
      });
      if (!m || m.conversationId !== c.id || m.deletedAt) return 'taken';
      if (!m.pending) {
        const mineUnanswered =
          m.ackedByCloud &&
          !(await this.messages.answeredAfter(
            scope,
            c.id,
            { kind: 'cloud' },
            m.sentAt,
          ));
        return mineUnanswered ? 'acked' : 'taken';
      }
      m.ack(await this.messages.databaseNow(), { kind: 'cloud' });
      await this.messages.save(scope, m);
      return 'acked';
    });
  }

  /**
   * The cloud's answer, encrypted with the CURRENT conversation key (the job seals it with the key opened from the
   * server copy): born acknowledged, `authorCloud`. Same rules and errors as any executor message (409
   * `conversation-key-version-stale` / `conversation-key-rotation-required`, 422 `space-storage-full`, idempotent by id);
   * out of the cloud's reach: 404 `conversation-not-found`.
   */
  send(
    organizationId: string,
    spaceId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<{ view: MessageView; created: boolean }> {
    return this.sending.byCloud(organizationId, spaceId, conversationId, input);
  }

  private async lockConversation(
    organizationId: string,
    spaceId: string,
    conversationId: string,
  ): Promise<Conversation | null> {
    if (!(await this.spaceCloud.lockActiveForWrite(organizationId, spaceId))) {
      return null;
    }
    const c = await this.conversations.lockById(
      scopeOf(organizationId, spaceId),
      conversationId,
      'no-key-update',
    );
    return c && c.spaceId === spaceId && c.isCloudExecutor() ? c : null;
  }

  private async isActive(
    organizationId: string,
    spaceId: string,
  ): Promise<boolean> {
    return (
      (await this.spaceCloud.modeOf(organizationId, spaceId)) === 'active_cloud'
    );
  }
}

const scopeOf = (
  organizationId: string,
  spaceId: string,
): ConversationScope => ({
  organizationId,
  actor: { kind: 'cloud', spaceId },
});

function view(c: Conversation): CloudConversationView {
  return {
    id: c.id,
    organizationId: c.organizationId,
    spaceId: c.spaceId,
    ownerUserId: c.ownerUserId,
    executorHubId: c.executorHubId,
    state: c.state,
    currentKeyVersion: c.currentKeyVersion,
    keyRotationRequired: c.keyRotationRequired,
    participantUserIds: c.participantUserIds,
    encryptedHeader: c.encryptedHeader,
    headerKeyVersion: c.headerKeyVersion,
    lastMessageAt: c.lastMessageAt,
  };
}

function messageOf(m: ConversationMessage): CloudMessageView {
  return {
    id: m.id,
    authorUserId: m.authorUserId,
    authorHubId: m.authorHubId,
    authorCloud: m.authorCloud,
    keyVersion: m.keyVersion,
    encryptedBody: m.encryptedBody!,
    replacesMessageId: m.replacesMessageId,
    pending: m.pending,
    sentAt: m.sentAt,
  };
}
