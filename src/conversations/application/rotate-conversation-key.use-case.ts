import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import type { HubAuthContext } from '../../shared/application/hub-auth-context.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertRecipientsMatch } from '../domain/conversation-keys.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationParticipantRepository } from '../domain/conversation-participant.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { assertKeyVersion } from '../domain/device-id.js';
import { assertWrappedConversationKey } from '../domain/wrapped-conversation-key.js';
import {
  ConversationAccess,
  type ScopedConversation,
} from './conversation-access.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

export type RotateConversationKeyInput = {
  /** Must be current_key_version + 1 (else 409 `conversation-key-version-stale` with `expectedVersion`). */
  version: number;
  /** The new version sealed for exactly the live participants. */
  grants: { userId: string; wrappedKey: string }[];
  /** And for the executor (empty without one). */
  hubGrants: { hubId: string; wrappedKey: string }[];
};

// Troca da chave do assunto (spec §4.2): versão nova (atual + 1) para EXATAMENTE o conjunto ativo, lido sob o lock do
// assunto: os participantes vivos e o executor (409 `key-rotation-mismatch` com os ids faltando/sobrando, como na
// troca da chave do espaço). Com troca pendente (alguém saiu, executor trocado/perdido), qualquer participante ou o
// executor troca (o executor já tem a chave e conhece as chaves públicas pela sincronização: a fila não para); sem
// ela, só o dono (409 `key-rotation-not-required`). Cada troca grava linhas novas de cópia por versão (as colunas de
// identidade são imutáveis). Lock: só o assunto.
@Injectable()
export class RotateConversationKeyUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly conversations: ConversationRepository,
    private readonly participants: ConversationParticipantRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly views: ConversationViews,
    private readonly uow: UnitOfWork,
  ) {}

  byUser(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    input: RotateConversationKeyInput,
  ): Promise<ConversationView> {
    validate(input);
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      return this.rotate(
        await this.access.lockForUser(spaceId, conversationId, actor.userId),
        input,
      );
    });
  }

  byHub(
    hub: HubAuthContext,
    conversationId: string,
    input: RotateConversationKeyInput,
  ): Promise<ConversationView> {
    validate(input);
    return this.uow.run(async () => {
      await this.uow.setContext({ hubId: hub.hubId });
      return this.rotate(
        await this.access.lockForHub(hub.hubId, conversationId),
        input,
      );
    });
  }

  private async rotate(
    { scope, conversation }: ScopedConversation,
    input: RotateConversationKeyInput,
  ): Promise<ConversationView> {
    conversation.assertRotationAllowed(scope.actor);
    // Só em memória até aqui: 409 `conversation-key-version-stale` se a versão não for a seguinte.
    conversation.completeRotation(input.version);
    assertRecipientsMatch(
      {
        userIds: input.grants.map((g) => g.userId),
        hubIds: input.hubGrants.map((g) => g.hubId),
      },
      {
        userIds: (await this.participants.listLive(scope, conversation.id)).map(
          (p) => p.userId,
        ),
        hubIds: conversation.executorHubId ? [conversation.executorHubId] : [],
      },
    );
    for (const g of input.grants) {
      await this.grants.put(scope, conversation.id, {
        keyVersion: input.version,
        recipient: { kind: 'user', userId: g.userId },
        wrappedKey: g.wrappedKey,
      });
    }
    for (const g of input.hubGrants) {
      await this.grants.put(scope, conversation.id, {
        keyVersion: input.version,
        recipient: { kind: 'hub', hubId: g.hubId },
        wrappedKey: g.wrappedKey,
      });
    }
    await this.conversations.save(scope, conversation);
    return this.views.reload(scope, conversation.id);
  }
}

function validate(input: RotateConversationKeyInput): void {
  assertKeyVersion(input.version);
  for (const g of [...input.grants, ...input.hubGrants]) {
    assertWrappedConversationKey(g.wrappedKey);
  }
}
