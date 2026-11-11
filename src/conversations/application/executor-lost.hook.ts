import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { ConflictError } from '../../shared/domain/errors.js';
import {
  HubExecutorLostHooks,
  type HubExecutorLostContext,
} from '../../shared/application/hub-executor-lost-hooks.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';

const HOOK_NAME = 'conversations.executor-lost';
/** A concurrent owner change between the unlocked read and the lock: read again (bounded). */
const MAX_ATTEMPTS = 3;

// O Hub deixou de valer numa organização (desregistro, desvínculo) ou num espaço (tirado do Hub): em cada assunto de
// que ele é executor ali (spec §4.1), `executorHubId` volta a nulo, lápide nas cópias do Hub e troca de chave
// pendente; as mensagens `pending` continuam esperando um executor novo, e as que ele confirmou sem responder voltam a
// `pending` (`requeueAckedBy`). Roda dentro da transação de quem emite (o
// `hubs`), depois de Hub, vínculo, hub_space e espaços travados: os assuntos são travados por último, um a um em
// ordem (espaço, assunto). Erro desfaz a operação do `hubs` inteira.
// Contexto (migration CreateConversations): os ids vêm do contexto do PRÓPRIO Hub (que só vê onde é executor, sem
// lock); a escrita roda no contexto do DONO do assunto (sempre participante), nunca no do Hub, cuja linha nova não
// passaria pela policy dele (42501). O dono pode mudar entre a leitura e o lock (sucessão): lê de novo, até
// MAX_ATTEMPTS; sem conseguir, 409 `conversation-owner-changing` (desfaz a operação do `hubs`, que pode ser repetida).
@Injectable()
export class ConversationsExecutorLostHook
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly hooks: HubExecutorLostHooks,
    private readonly conversations: ConversationRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly audit: AuditLog,
    private readonly messages: ConversationMessageRepository,
    private readonly reserve: ConversationCloudReserve,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      onExecutorLost: (ctx) => this.onExecutorLost(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async onExecutorLost(ctx: HubExecutorLostContext): Promise<void> {
    const { hubId, organizationId } = ctx;
    const hubScope: ConversationScope = {
      organizationId,
      actor: { kind: 'hub', hubId },
    };
    const ids = await this.conversations.idsWithExecutor(
      hubScope,
      hubId,
      ctx.spaceId,
    );
    for (const id of ids) {
      if (!(await this.clear(ctx, hubScope, id))) {
        // Nunca deixar o Hub como executor (com cópias vivas e sem troca pendente) e confirmar a operação do `hubs`:
        // o erro desfaz tudo e o pedido pode ser repetido.
        throw new ConflictError(
          'conversation-owner-changing',
          'A conversation changed owner repeatedly while its executor was being removed; try again.',
        );
      }
    }
  }

  /** True when the conversation no longer has the hub as executor (cleared here or already gone). */
  private async clear(
    ctx: HubExecutorLostContext,
    hubScope: ConversationScope,
    id: string,
  ): Promise<boolean> {
    const { hubId, organizationId } = ctx;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const seen = await this.conversations.findById(hubScope, id);
      if (!seen || !seen.isExecutor(hubId)) return true;
      const ownerScope: ConversationScope = {
        organizationId,
        actor: { kind: 'user', userId: seen.ownerUserId },
      };
      const conversation = await this.conversations.lockById(ownerScope, id);
      // O dono mudou (ou saiu) entre a leitura e o lock: lê de novo.
      if (!conversation || !conversation.isOwner(seen.ownerUserId)) continue;
      if (!conversation.isExecutor(hubId)) return true;
      conversation.loseExecutor();
      await this.conversations.save(ownerScope, conversation);
      await this.grants.removeFor(ownerScope, id, { kind: 'hub', hubId });
      // With the cloud reserve on, the requeued messages are the cloud's to take (signal in this same transaction).
      await this.reserve.requeued(
        conversation,
        await this.messages.requeueAckedBy(ownerScope, id, {
          kind: 'hub',
          hubId,
        }),
      );
      await this.audit.record({
        organizationId,
        userId: ctx.actorId,
        action: 'conversation.executor_lost',
        metadata: {
          conversationId: id,
          spaceId: conversation.spaceId,
          hubId,
          reason: ctx.reason,
        },
      });
      return true;
    }
    return false;
  }
}
