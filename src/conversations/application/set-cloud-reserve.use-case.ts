import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { DomainValidationError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceCloud } from '../../spaces/application/space-cloud.js';
import { cloudReserveUnavailable } from '../domain/conversation-errors.js';
import { assertVersionsCovered } from '../domain/conversation-keys.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { assertWrappedConversationKey } from '../domain/wrapped-conversation-key.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

export type SetCloudReserveInput = {
  enabled: boolean;
  /** To switch it on: every version 1..current sealed for the server key (`GET /cloud/server-key`). */
  serverGrants: { keyVersion: number; wrappedKey: string }[];
};

// Ligar/desligar a nuvem de reserva de um assunto (spec active-cloud §4.3, primeiro parágrafo):
// - LIGAR: o espaço precisa estar em `active_cloud` (lido com o espaço FOR SHARE; 422 `cloud-reserve-unavailable`) e o
//   pedido traz as cópias de TODAS as versões para a chave do servidor (409 `key-versions-mismatch`), cada uma conferida
//   (abre com a chave do servidor; 422 `server-copy-invalid`). Qualquer participante liga (é assim que um assunto que já
//   existia quando o espaço passou a nuvem ativa ganha a reserva: o app manda as cópias quando alguém o abre), menos
//   depois de o DONO desligar: aí só o dono (403 `not-conversation-owner`). Já ligada: devolve o assunto, sem gravar.
//   As mensagens que já esperam (`pending`) viram sinal para a nuvem (`CloudReservePendingHooks`).
// - DESLIGAR: só o dono (403). As cópias do servidor são APAGADAS (não lápide: material de chave), a troca de chave fica
//   pendente (o servidor conhecia a chave; a próxima versão não vai para ele), o que a nuvem confirmou sem responder
//   volta a `pending` (para o Hub), e a recusa fica gravada (um participante não a liga de novo). Já desligada: só
//   grava a recusa.
// Auditado `conversation.cloud_reserve_enabled|disabled` (só ids). Locks: espaço FOR SHARE (só ao ligar) -> assunto
// FOR UPDATE. Não membro do espaço, não participante, assunto de outro espaço: o mesmo 404 `conversation-not-found`.
@Injectable()
export class SetCloudReserveUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly conversations: ConversationRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly reserve: ConversationCloudReserve,
    private readonly spaceCloud: SpaceCloud,
    private readonly views: ConversationViews,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    input: SetCloudReserveInput,
  ): Promise<ConversationView> {
    const { userId } = actor;
    if (!input.enabled && input.serverGrants.length > 0) {
      throw new DomainValidationError(
        'server-grants-unexpected',
        'Switching the cloud reserve off takes no copy.',
      );
    }
    for (const g of input.serverGrants) {
      assertWrappedConversationKey(g.wrappedKey);
    }
    return this.uow.run(async () => {
      await this.uow.setContext({ userId });
      const scope = await this.access.userScope(spaceId, actor);
      if (input.enabled) {
        // Space before conversation (global lock order); switching the space's cloud off takes it FOR UPDATE.
        const active = await this.spaceCloud.lockActiveForWrite(
          scope.organizationId,
          spaceId,
        );
        const conversation = await this.access.lock(
          scope,
          conversationId,
          spaceId,
        );
        if (!active) throw cloudReserveUnavailable();
        if (!conversation.enableCloudReserve(userId)) {
          return this.views.of(scope, conversation);
        }
        assertVersionsCovered(
          input.serverGrants.map((g) => g.keyVersion),
          conversation.currentKeyVersion,
        );
        await this.reserve.assertServerCopies(
          input.serverGrants.map((g) => g.wrappedKey),
        );
        for (const g of input.serverGrants) {
          await this.reserve.putServerCopy(
            scope,
            conversation.id,
            g.keyVersion,
            g.wrappedKey,
          );
        }
        await this.conversations.save(scope, conversation);
        for (const m of await this.messages.listPending(
          scope,
          conversation.id,
        )) {
          await this.reserve.signal(conversation, m.id, 'reserve_enabled');
        }
        await this.record(conversation.organizationId, userId, 'enabled', {
          conversationId: conversation.id,
          spaceId,
        });
        return this.views.reload(scope, conversation.id);
      }
      const conversation = await this.access.lock(
        scope,
        conversationId,
        spaceId,
      );
      const wasOn = conversation.declineCloudReserve(userId);
      await this.conversations.save(scope, conversation);
      if (wasOn) {
        await this.reserve.dropServerSide(scope, conversation);
        await this.record(conversation.organizationId, userId, 'disabled', {
          conversationId: conversation.id,
          spaceId,
        });
      }
      return this.views.reload(scope, conversation.id);
    });
  }

  private record(
    organizationId: string,
    userId: string,
    change: 'enabled' | 'disabled',
    metadata: { conversationId: string; spaceId: string },
  ): Promise<void> {
    return this.audit.record({
      organizationId,
      userId,
      action: `conversation.cloud_reserve_${change}`,
      metadata,
    });
  }
}
