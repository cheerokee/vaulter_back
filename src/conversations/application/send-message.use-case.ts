import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { ConflictError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceCloud } from '../../spaces/application/space-cloud.js';
import { SpaceStorage } from '../../spaces/application/space-storage.js';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import {
  assertSpaceFits,
  conversationNotFound,
  messageIdConflict,
  messageReplacesInvalid,
  messageTooLarge,
} from '../domain/conversation-errors.js';
import { MAX_MESSAGE_BYTES } from '../domain/conversation-limits.js';
import { ConversationMessage } from '../domain/conversation-message.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import type { Conversation } from '../domain/conversation.js';
import { assertDeviceId, assertKeyVersion } from '../domain/device-id.js';
import { assertEncryptedBlob } from '../domain/encrypted-blob.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';
import { messageView, type MessageView } from './dto/message-view.js';

export type SendMessageInput = {
  /** UUID v7 from the device (part of the encryption AD): resending it is idempotent. */
  id: string;
  /** Must be the current version of the conversation key. */
  keyVersion: number;
  encryptedBody: string;
  /** Edit: the message (mine, live, of this conversation) this one replaces; it becomes a tombstone. */
  replacesMessageId: string | null;
  /** "Responder pela nuvem" for this message (a person's only; ignored for the executor's own messages). */
  cloudAnswerRequested?: boolean;
};

/** The cloud's answer must still be its own to give (`byCloud`'s `answering`): 409, nothing written. */
export class CloudAnswerNotOwnedError extends ConflictError {
  constructor() {
    super(
      'cloud-answer-not-owned',
      'The message is no longer acknowledged by the cloud.',
    );
  }
}

// Mandar mensagem (spec conversations §4.3), pela pessoa (rotas do espaço) ou pelo Hub executor (rotas `/hub`):
// 1. formato antes de travar nada (id v7, corpo cifrado ≤ 64 KiB: 422);
// 2. no unit of work, na ordem global: espaço `FOR SHARE` (`SpaceStorage.lockQuota`: a intenção de envio do backup,
//    que trava o espaço `FOR UPDATE`, espera este envio e vice-versa) -> assunto `FOR NO KEY UPDATE` (envios e acks se
//    serializam entre si e com toda mudança `FOR UPDATE`, mas não esperam a cópia no S3 de uma confirmação de anexo,
//    que segura `FOR KEY SHARE`; `ConversationLockMode`);
// 3. idempotência: o mesmo id já existe NESTE assunto com o mesmo autor e o mesmo conteúdo = a mesma resposta (200,
//    nada gravado; vale também depois de uma troca de chave pendente). Qualquer outra coisa com esse id (outro conteúdo,
//    outro autor, outro assunto, ou um id que o escopo nem vê: `insertIfAbsent` devolve false) = 409
//    `message-id-conflict`, nunca "já mandada";
// 4. troca de chave pendente / versão diferente da atual: 409 (nada gravado); edição: a substituída tem de ser minha
//    (403) e viva deste assunto (422), e vira lápide DEPOIS de gravar a nova (ordem do `sync_version` nos feeds);
// 5. grava no relógio do banco (`sentAt`, `lastMessageAt`); mensagem de pessoa nasce `pending`, a do executor já
//    confirmada (CHECK no banco);
// 6. DEPOIS de gravar, lê o uso do espaço inteiro (porta `SpaceStorageUsage`: backup + assuntos; o trigger já contou
//    esta mensagem e o contador do espaço serializa envios concorrentes) e confere que cabe: senão 422
//    `space-storage-full` com `missingBytes`, e o unit of work desfaz tudo.
@Injectable()
export class SendMessageUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly spaceStorage: SpaceStorage,
    private readonly usage: SpaceStorageUsage,
    private readonly conversations: ConversationRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly uow: UnitOfWork,
    private readonly spaceCloud: SpaceCloud,
    private readonly reserve: ConversationCloudReserve,
  ) {}

  async byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<{ view: MessageView; created: boolean }> {
    validate(input);
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const scope = await this.access.userScope(spaceId, actor);
      const quotaBytes = await this.lockSpace(scope, spaceId);
      const conversation = await this.access.lock(
        scope,
        conversationId,
        spaceId,
        'no-key-update',
      );
      return this.send(scope, conversation, quotaBytes, input);
    });
  }

  async byHub(
    hub: HubAuthContext,
    conversationId: string,
    input: SendMessageInput,
  ): Promise<{ view: MessageView; created: boolean }> {
    validate(input);
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      // Sem trava aqui: só para achar a organização e o espaço (imutáveis) antes de travar o espaço.
      const { scope, conversation: seen } = await this.access.findForHub(
        hub.hubId,
        conversationId,
      );
      const quotaBytes = await this.lockSpace(scope, seen.spaceId);
      const conversation = await this.access.lock(
        scope,
        conversationId,
        seen.spaceId,
        'no-key-update',
      );
      return this.send(scope, conversation, quotaBytes, input);
    });
  }

  /**
   * The cloud as the reserve executor writes an answer (spec active-cloud §4.3): born acknowledged, `authorCloud`.
   * Only in a conversation with the reserve on, of a space still in the active cloud (read under the space lock);
   * anything else is the same 404 `conversation-not-found`. For the `cloud` jobs, through `CloudConversationExecutor`.
   * `answering`: the person's message this answers; rechecked under the conversation lock: it must still be acknowledged
   * by the cloud (else 409 `cloud-answer-not-owned`, nothing written: the reserve went off and the message went back to
   * the queue, maybe to the Hub, while the cloud was thinking).
   */
  async byCloud(
    organizationId: string,
    spaceId: string,
    conversationId: string,
    input: SendMessageInput,
    answering?: string,
  ): Promise<{ view: MessageView; created: boolean }> {
    validate(input);
    return this.uow.run(async () => {
      await this.uow.setContext({ cloudExecutorSpaceId: spaceId });
      const scope: ConversationScope = {
        organizationId,
        actor: { kind: 'cloud', spaceId },
      };
      const quotaBytes = await this.lockSpace(scope, spaceId);
      // The space row is held FOR SHARE (lockQuota): switching the cloud off waits for this answer, or comes first.
      if (
        (await this.spaceCloud.modeOf(organizationId, spaceId)) !==
        'active_cloud'
      ) {
        throw conversationNotFound();
      }
      const conversation = await this.access.lock(
        scope,
        conversationId,
        spaceId,
        'no-key-update',
      );
      if (answering !== undefined) {
        const question = await this.messages.findById(scope, answering, {
          withDeleted: true,
        });
        const ownAnswer = await this.messages.findById(scope, input.id, {
          withDeleted: true,
        });
        // A resend of the same answer stays idempotent (the question may have been answered by it already).
        if (
          !ownAnswer &&
          (!question ||
            question.conversationId !== conversation.id ||
            question.deletedAt ||
            !question.ackedByCloud)
        ) {
          throw new CloudAnswerNotOwnedError();
        }
      }
      return this.send(scope, conversation, quotaBytes, input);
    });
  }

  private async lockSpace(
    scope: ConversationScope,
    spaceId: string,
  ): Promise<number> {
    const quotaBytes = await this.spaceStorage.lockQuota(
      scope.organizationId,
      spaceId,
    );
    if (quotaBytes === null) throw conversationNotFound();
    return quotaBytes;
  }

  private async send(
    scope: ConversationScope,
    conversation: Conversation,
    quotaBytes: number,
    input: SendMessageInput,
  ): Promise<{ view: MessageView; created: boolean }> {
    const now = await this.messages.databaseNow();
    const message = ConversationMessage.create({
      id: input.id,
      organizationId: scope.organizationId,
      conversationId: conversation.id,
      author: scope.actor,
      keyVersion: input.keyVersion,
      encryptedBody: input.encryptedBody,
      replacesMessageId: input.replacesMessageId,
      cloudAnswerRequested: input.cloudAnswerRequested ?? false,
      sentAt: now,
      now,
    });

    const existing = await this.messages.findById(scope, message.id, {
      withDeleted: true,
    });
    if (existing) {
      if (existing.isSameSubmission(message)) {
        return { view: messageView(existing), created: false };
      }
      throw messageIdConflict();
    }

    conversation.assertCanWrite(message.keyVersion);
    let replaced: ConversationMessage | null = null;
    if (message.replacesMessageId) {
      replaced = await this.messages.findById(
        scope,
        message.replacesMessageId,
        { withDeleted: true },
      );
      if (
        !replaced ||
        replaced.conversationId !== conversation.id ||
        replaced.deletedAt
      ) {
        throw messageReplacesInvalid();
      }
      replaced.assertAuthor(scope.actor);
    }

    if (!(await this.messages.insertIfAbsent(scope, message))) {
      throw messageIdConflict();
    }
    // Edit: the replacement is written BEFORE the tombstone of the original, so its `sync_version` is lower and a feed
    // page never delivers the tombstone without the replacement (a page may end between them: the client then shows the
    // replacement, which names the message it replaces, and the original goes on the next page).
    if (replaced) {
      replaced.tombstone(now);
      await this.messages.save(scope, replaced);
    }
    conversation.recordMessage(now);
    await this.conversations.save(scope, conversation);
    // A person's message waits for the executor: with the cloud reserve on, the cloud may take it (same transaction).
    if (message.pending) {
      await this.reserve.signal(conversation, message.id, 'sent', {
        cloudAnswerRequested: message.cloudAnswerRequested,
      });
    }

    assertSpaceFits(
      quotaBytes,
      await this.usage.usedBytes(scope.organizationId, conversation.spaceId),
    );
    return { view: messageView(message), created: true };
  }
}

function validate(input: SendMessageInput): void {
  assertDeviceId(input.id, 'message-id-invalid');
  assertKeyVersion(input.keyVersion);
  assertEncryptedBlob(input.encryptedBody, MAX_MESSAGE_BYTES, () =>
    messageTooLarge(MAX_MESSAGE_BYTES),
  );
}
