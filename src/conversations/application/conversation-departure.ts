import { Injectable } from '@nestjs/common';
import { AuditLog } from '../../organizations/application/audit-log.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationParticipantRepository } from '../domain/conversation-participant.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import type { Conversation } from '../domain/conversation.js';
import { planDeparture } from '../domain/participation-rules.js';
import { ConversationExecutors } from './conversation-executors.js';

export type DepartureResult = {
  ended: boolean;
  newOwnerUserId: string | null;
  lostExecutorHubId: string | null;
};

// Saída de um participante (sair, ser tirado pelo dono, sair do espaço; spec §4.2). PRÉ-CONDIÇÃO: dentro do
// UnitOfWork.run, com o assunto travado (`lockById`) no `scope` de um PARTICIPANTE vivo (quem sai, ou o dono que tira).
// Ordem das gravações (migration CreateConversations, "Quem sai"): tudo o que muda no assunto (dono novo, executor,
// troca pendente, lápide do assunto), a lápide nas cópias do Hub que deixa de valer e nas cópias de quem sai, e por
// ÚLTIMO a lápide da participação: quando quem sai é o próprio `scope`, depois dela o assunto some para ele.
// - dono sai e há outros: o participante mais antigo vira dono;
// - quem sai é o dono do Hub executor: o executor sai junto (lápide nas cópias do Hub);
// - último participante sai: lápide no assunto (privado é privado);
// - sempre: troca de chave pendente.
@Injectable()
export class ConversationDeparture {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly participants: ConversationParticipantRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly executors: ConversationExecutors,
    private readonly audit: AuditLog,
  ) {}

  async depart(
    scope: ConversationScope,
    conversation: Conversation,
    leavingUserId: string,
    input: { now: Date; actorId: string | null },
  ): Promise<DepartureResult> {
    const id = conversation.id;
    const plan = planDeparture({
      ownerUserId: conversation.ownerUserId,
      participants: await this.participants.listLive(scope, id),
      leavingUserId,
      executorOwnerUserId: await this.executors.ownerOf(
        conversation.executorHubId,
      ),
    });
    const lostExecutorHubId = plan.executorLeaves
      ? conversation.executorHubId
      : null;
    if (lostExecutorHubId) conversation.loseExecutor();
    if (plan.newOwnerUserId)
      conversation.transferOwnership(plan.newOwnerUserId);
    conversation.markRotationRequired();
    if (plan.conversationEnds) conversation.tombstone(input.now);
    await this.conversations.save(scope, conversation);
    if (lostExecutorHubId) {
      await this.grants.removeFor(scope, id, {
        kind: 'hub',
        hubId: lostExecutorHubId,
      });
      await this.audit.record({
        organizationId: conversation.organizationId,
        userId: input.actorId,
        action: 'conversation.executor_lost',
        metadata: {
          conversationId: id,
          spaceId: conversation.spaceId,
          hubId: lostExecutorHubId,
          reason: 'owner_left_conversation',
        },
      });
    }
    await this.grants.removeFor(scope, id, {
      kind: 'user',
      userId: leavingUserId,
    });
    // Por último (veja o comentário da classe).
    await this.participants.remove(scope, id, leavingUserId);
    return {
      ended: plan.conversationEnds,
      newOwnerUserId: plan.newOwnerUserId,
      lostExecutorHubId,
    };
  }
}
