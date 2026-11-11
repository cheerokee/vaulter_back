import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { ConversationMessageRepository } from '../domain/conversation-message.repository.js';
import { ConversationRepository } from '../domain/conversation.repository.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationCloudReserve } from './conversation-cloud-reserve.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

// "Responder pela nuvem" no assunto inteiro (spec active-cloud §4.3: "a pessoa pode marcar responder pela nuvem no
// assunto"). Qualquer participante liga ou desliga (só muda QUEM responde primeiro, nunca quem lê: a nuvem já tem a
// chave pela reserva); ligar exige a reserva (422 `cloud-reserve-unavailable`). Ao ligar, as mensagens que já esperam
// viram sinal imediato para a nuvem (`CloudReservePendingHooks`, motivo `cloud_answer`). A reserva caindo (dono
// desliga, espaço sai da nuvem, lápide) desliga junto. Trava só o assunto FOR UPDATE. Não participante, não membro do
// espaço, assunto de outro espaço: o mesmo 404 `conversation-not-found`.
@Injectable()
export class SetCloudAnswerUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly conversations: ConversationRepository,
    private readonly messages: ConversationMessageRepository,
    private readonly reserve: ConversationCloudReserve,
    private readonly views: ConversationViews,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    enabled: boolean,
  ): Promise<ConversationView> {
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const scope = await this.access.userScope(spaceId, actor);
      const conversation = await this.access.lock(
        scope,
        conversationId,
        spaceId,
      );
      if (!conversation.setCloudAnswer(actor.userId, enabled)) {
        return this.views.of(scope, conversation);
      }
      await this.conversations.save(scope, conversation);
      if (enabled) {
        for (const m of await this.messages.listPending(
          scope,
          conversation.id,
        )) {
          await this.reserve.signal(conversation, m.id, 'cloud_answer');
        }
      }
      return this.views.reload(scope, conversation.id);
    });
  }
}
