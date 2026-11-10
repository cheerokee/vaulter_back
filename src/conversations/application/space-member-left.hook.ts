import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import {
  SpaceMemberLeftHooks,
  type SpaceMemberLeftContext,
} from '../../shared/application/space-member-left-hooks.js';
import type { ConversationScope } from '../domain/conversation-actor.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { ConversationDeparture } from './conversation-departure.js';

const HOOK_NAME = 'conversations.space-member-left';

// Quem sai do espaço (sai, é tirado, ou sai da organização: o `spaces` emite uma vez por espaço) sai de todos os
// assuntos daquele espaço (spec §4.2), com a mesma saída de "sair do assunto" (`ConversationDeparture`: dono novo,
// executor que sai junto se ela era dona do Hub, lápide quando era a última, troca pendente). Roda dentro da transação
// da saída, com o espaço JÁ travado pelo `spaces` (FOR UPDATE): os assuntos vêm depois, um a um em ordem de id, cada
// um no contexto de quem sai (ainda participante; a lápide da participação dela é a última gravação de cada assunto).
// Erro desfaz a saída do espaço.
@Injectable()
export class ConversationsSpaceMemberLeftHook
  implements OnModuleInit, OnModuleDestroy
{
  constructor(
    private readonly hooks: SpaceMemberLeftHooks,
    private readonly conversations: ConversationRepository,
    private readonly departure: ConversationDeparture,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      onSpaceMemberLeft: (ctx) => this.onSpaceMemberLeft(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async onSpaceMemberLeft(ctx: SpaceMemberLeftContext): Promise<void> {
    const { organizationId, spaceId, userId, now } = ctx;
    const scope: ConversationScope = {
      organizationId,
      actor: { kind: 'user', userId },
    };
    const ids = await this.conversations.idsWithParticipant(
      scope,
      spaceId,
      userId,
    );
    for (const id of ids) {
      const conversation = await this.conversations.lockById(scope, id);
      // Saiu do assunto no meio (outra transação já confirmou): nada a fazer.
      if (!conversation || !conversation.isParticipant(userId)) continue;
      await this.departure.depart(scope, conversation, userId, {
        now,
        actorId: null,
      });
    }
  }
}
