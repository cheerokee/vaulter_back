import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { ConflictError } from '../../shared/domain/errors.js';
import {
  SpaceCloudDeactivatedHooks,
  type SpaceCloudDeactivatedContext,
} from '../../shared/application/space-cloud-deactivated-hooks.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';

const HOOK_NAME = 'conversations.cloud-deactivated';
/** A concurrent owner change between the unlocked read and the lock: read again (bounded). */
const MAX_ATTEMPTS = 3;

// O espaço saiu da nuvem ativa (o `cloud` desliga; spec active-cloud §4.1): a nuvem deixa de ser executor de reserva
// em TODO assunto do espaço que a tinha. Em cada um: `cloud_reserve` falso (não é escolha do dono: não fica gravada
// como recusa), cópias da chave do assunto para o servidor APAGADAS, troca de chave pendente (o servidor conhecia a
// chave) e o que a nuvem confirmou sem responder volta a `pending` (para o Hub). Auditado
// `conversation.cloud_reserve_lost` (só ids). Roda dentro da transação do desligar, com o espaço travado FOR UPDATE:
// os assuntos são travados depois, um a um em ordem (espaço, assunto).
// Contexto (como o executor perdido, `ConversationsExecutorLostHook`): os ids vêm do contexto da NUVEM daquele espaço
// (`app.cloud_executor`, sem lock; só mostra os assuntos com a reserva); a escrita roda no contexto do DONO do assunto
// (sempre participante), nunca no da nuvem, que deixaria de ver a linha ao gravá-la (42501). Dono mudou entre a leitura
// e o lock: lê de novo, até MAX_ATTEMPTS; sem conseguir, 409 `conversation-owner-changing` (desfaz o desligar).
@Injectable()
export class ConversationsCloudDeactivatedHook
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly hooks: SpaceCloudDeactivatedHooks,
    private readonly conversations: ConversationRepository,
    private readonly reserve: ConversationCloudReserve,
    private readonly audit: AuditLog,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      onSpaceCloudDeactivated: (ctx) => this.onDeactivated(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async onDeactivated(ctx: SpaceCloudDeactivatedContext): Promise<void> {
    const cloudScope: ConversationScope = {
      organizationId: ctx.organizationId,
      actor: { kind: 'cloud', spaceId: ctx.spaceId },
    };
    for (const id of await this.conversations.idsWithCloudReserve(
      cloudScope,
      ctx.spaceId,
    )) {
      if (!(await this.clear(ctx, cloudScope, id))) {
        throw new ConflictError(
          'conversation-owner-changing',
          'A conversation changed owner repeatedly while the cloud was being switched off; try again.',
        );
      }
    }
  }

  /** True when the conversation no longer has the cloud reserve (cleared here or already gone). */
  private async clear(
    ctx: SpaceCloudDeactivatedContext,
    cloudScope: ConversationScope,
    id: string,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const seen = await this.conversations.findById(cloudScope, id);
      if (!seen || !seen.cloudReserve) return true;
      const ownerScope: ConversationScope = {
        organizationId: ctx.organizationId,
        actor: { kind: 'user', userId: seen.ownerUserId },
      };
      const conversation = await this.conversations.lockById(ownerScope, id);
      if (!conversation || !conversation.isOwner(seen.ownerUserId)) continue;
      if (!conversation.loseCloudReserve()) return true;
      await this.conversations.save(ownerScope, conversation);
      await this.reserve.dropServerSide(ownerScope, conversation);
      await this.audit.record({
        organizationId: ctx.organizationId,
        userId: ctx.actorUserId,
        action: 'conversation.cloud_reserve_lost',
        metadata: {
          conversationId: id,
          spaceId: conversation.spaceId,
          reason: 'space_cloud_deactivated',
        },
      });
      return true;
    }
    return false;
  }
}
