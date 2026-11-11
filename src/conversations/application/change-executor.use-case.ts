import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { DomainValidationError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { assertVersionsCovered } from '../domain/conversation-keys.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { assertExecutorEligible } from '../domain/participation-rules.js';
import { assertWrappedConversationKey } from '../domain/wrapped-conversation-key.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationExecutors } from './conversation-executors.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

export type ChangeExecutorInput = {
  /** The new executor, or null to leave the conversation without one (messages wait as pending). */
  hubId: string | null;
  /** Every version 1..current sealed for the new hub (empty with `hubId: null`). */
  grants: { keyVersion: number; wrappedKey: string }[];
};

// Trocar o executor (spec §4.1): só o DONO (403 `not-conversation-owner`). O Hub novo segue a regra do executor (dono
// do Hub participa, espaço instalado com vínculo aprovado; 422 `executor-invalid`) e recebe as cópias de TODAS as
// versões (409 `key-versions-mismatch`). Havendo um executor anterior, ele perde as cópias (lápide) e a troca de chave
// fica pendente: o antigo conhecia a chave (o novo, ou qualquer participante, faz a troca); as mensagens que o antigo
// confirmou e não respondeu voltam a `pending` (`requeueAckedBy`). Auditado
// (`conversation.executor_changed`, só ids). Locks: Hub novo -> vínculo -> hub_space (FOR SHARE) -> assunto
// (FOR UPDATE); a checagem de dono antes das travas é sem lock e se repete sob o lock do assunto.
@Injectable()
export class ChangeExecutorUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly executors: ConversationExecutors,
    private readonly conversations: ConversationRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly views: ConversationViews,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
    private readonly reserve: ConversationCloudReserve,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    input: ChangeExecutorInput,
  ): Promise<ConversationView> {
    const { userId } = actor;
    const { hubId } = input;
    if (hubId === null && input.grants.length > 0) {
      throw new DomainValidationError(
        'executor-grants-unexpected',
        'Without an executor there is no copy to send.',
      );
    }
    for (const g of input.grants) assertWrappedConversationKey(g.wrappedKey);
    return this.uow.run(async () => {
      await this.uow.setContext({ userId });
      const pre = await this.access.findForUser(spaceId, conversationId, actor);
      pre.conversation.assertOwner(userId);
      const { scope } = pre;
      const hubOwnerUserId =
        hubId === null
          ? null
          : await this.executors.lockEligible({
              hubId,
              organizationId: scope.organizationId,
              spaceId,
              participantUserIds: pre.conversation.participantUserIds,
            });
      const conversation = await this.access.lock(
        scope,
        conversationId,
        spaceId,
      );
      conversation.assertOwner(userId);
      const previous = conversation.executorHubId;
      if (previous === hubId) return this.views.of(scope, conversation);
      if (hubId !== null) {
        // De novo sob o lock do assunto: o dono do Hub pode ter saído desde a leitura sem lock.
        assertExecutorEligible({
          hubOwnerUserId,
          participantUserIds: conversation.participantUserIds,
          spaceInstalled: true,
        });
        assertVersionsCovered(
          input.grants.map((g) => g.keyVersion),
          conversation.currentKeyVersion,
        );
      }
      conversation.changeExecutor(hubId);
      await this.conversations.save(scope, conversation);
      if (previous) {
        await this.grants.removeFor(scope, conversation.id, {
          kind: 'hub',
          hubId: previous,
        });
        // What the old Hub took and never answered goes back to the inbox of the new one.
        await this.reserve.requeued(
          conversation,
          await this.messages.requeueAckedBy(scope, conversation.id, {
            kind: 'hub',
            hubId: previous,
          }),
        );
      }
      if (hubId) {
        for (const g of input.grants) {
          await this.grants.put(scope, conversation.id, {
            keyVersion: g.keyVersion,
            recipient: { kind: 'hub', hubId },
            wrappedKey: g.wrappedKey,
          });
        }
      }
      await this.audit.record({
        organizationId: scope.organizationId,
        userId,
        action: 'conversation.executor_changed',
        metadata: {
          conversationId: conversation.id,
          spaceId,
          fromHubId: previous,
          toHubId: hubId,
        },
      });
      return this.views.reload(scope, conversation.id);
    });
  }
}
