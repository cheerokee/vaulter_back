import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditLog } from '../../organizations/application/audit-log.js';
import {
  HubExecutorLostHooks,
  type HubExecutorLostContext,
} from '../../shared/application/hub-executor-lost-hooks.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';

const HOOK_NAME = 'conversations.executor-lost';
/** A concurrent owner change between the unlocked read and the lock: read again (bounded). */
const MAX_ATTEMPTS = 3;

// O Hub deixou de valer numa organização (desregistro, desvínculo) ou num espaço (tirado do Hub): em cada assunto de
// que ele é executor ali (spec §4.1), `executorHubId` volta a nulo, lápide nas cópias do Hub e troca de chave
// pendente; as mensagens `pending` continuam esperando um executor novo. Roda dentro da transação de quem emite (o
// `hubs`), depois de Hub, vínculo, hub_space e espaços travados: os assuntos são travados por último, um a um em
// ordem de id. Erro desfaz a operação do `hubs` inteira.
// Contexto (migration CreateConversations): os ids vêm do contexto do PRÓPRIO Hub (que só vê onde é executor, sem
// lock); a escrita roda no contexto do DONO do assunto (sempre participante), nunca no do Hub, cuja linha nova não
// passaria pela policy dele (42501). O dono pode mudar entre a leitura e o lock (sucessão): lê de novo.
@Injectable()
export class ConversationsExecutorLostHook
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly hooks: HubExecutorLostHooks,
    private readonly conversations: ConversationRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly audit: AuditLog,
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
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const seen = await this.conversations.findById(hubScope, id);
        if (!seen || !seen.isExecutor(hubId)) break;
        const ownerScope: ConversationScope = {
          organizationId,
          actor: { kind: 'user', userId: seen.ownerUserId },
        };
        const conversation = await this.conversations.lockById(ownerScope, id);
        if (!conversation || !conversation.isOwner(seen.ownerUserId)) continue;
        if (!conversation.isExecutor(hubId)) break;
        conversation.loseExecutor();
        await this.conversations.save(ownerScope, conversation);
        await this.grants.removeFor(ownerScope, id, { kind: 'hub', hubId });
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
        break;
      }
    }
  }
}
