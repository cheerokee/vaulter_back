import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceStorage } from '../../spaces/application/space-storage.js';
import { SpaceStorageUsage } from '../../spaces/application/space-storage-usage.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import {
  assertSpaceFits,
  conversationNotFound,
} from '../domain/conversation-errors.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import type { Conversation } from '../domain/conversation.js';
import { assertKeyVersion } from '../domain/device-id.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

export type ReplaceHeaderInput = {
  /** Must be the current version of the conversation key. */
  keyVersion: number;
  /** `0x01 ‖ nonce ‖ XChaCha20-Poly1305` with the conversation key (title, plan...), ≤ 16 KiB. */
  encryptedHeader: string;
};

// Trocar o cabeçalho cifrado do assunto (título, plano...; spec conversations §4.1): o DONO (rota do espaço; outro
// participante: 403 `not-conversation-owner`) ou o EXECUTOR (rota `/hub`; outro Hub: 404). Quem não participa: o mesmo
// 404 `conversation-not-found`. Versão = a atual (409 `conversation-key-version-stale`) e sem troca pendente (409
// `conversation-key-rotation-required`): o conteúdo novo nunca sai com uma chave que quem saiu conhece. Os bytes contam
// no uso do espaço como os das mensagens (trigger `trg_conversations_header_space_usage`): espaço `FOR SHARE`
// (`SpaceStorage.lockQuota`) -> assunto `FOR UPDATE` -> grava -> SÓ ENTÃO lê o uso e confere (422 `space-storage-full`
// com `missingBytes`; o unit of work desfaz). Mesmo cabeçalho de novo: grava de novo (idempotente no resultado).
@Injectable()
export class ReplaceConversationHeaderUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly spaceStorage: SpaceStorage,
    private readonly usage: SpaceStorageUsage,
    private readonly conversations: ConversationRepository,
    private readonly views: ConversationViews,
    private readonly uow: UnitOfWork,
  ) {}

  byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    input: ReplaceHeaderInput,
  ): Promise<ConversationView> {
    assertKeyVersion(input.keyVersion);
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const scope = await this.access.userScope(spaceId, actor.userId);
      const quotaBytes = await this.lockSpace(scope, spaceId);
      const conversation = await this.access.lock(
        scope,
        conversationId,
        spaceId,
      );
      conversation.assertOwner(actor.userId);
      return this.replace(scope, conversation, quotaBytes, input);
    });
  }

  byHub(
    hub: HubAuthContext,
    conversationId: string,
    input: ReplaceHeaderInput,
  ): Promise<ConversationView> {
    assertKeyVersion(input.keyVersion);
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
      );
      if (!conversation.isExecutor(hub.hubId)) throw conversationNotFound();
      return this.replace(scope, conversation, quotaBytes, input);
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

  private async replace(
    scope: ConversationScope,
    conversation: Conversation,
    quotaBytes: number,
    input: ReplaceHeaderInput,
  ): Promise<ConversationView> {
    conversation.replaceHeader(input.encryptedHeader, input.keyVersion);
    await this.conversations.save(scope, conversation);
    assertSpaceFits(
      quotaBytes,
      await this.usage.usedBytes(scope.organizationId, conversation.spaceId),
    );
    return this.views.reload(scope, conversation.id);
  }
}
