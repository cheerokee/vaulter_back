import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationDeparture } from './conversation-departure.js';

// Sair do assunto (qualquer participante) e tirar alguém (só o dono: 403 `not-conversation-owner`), spec §4.2.
// A saída em si é a `ConversationDeparture` (dono novo, executor que sai junto, lápide do assunto quando é o último,
// troca pendente; a lápide da participação de quem sai é a última gravação). Tirar a si mesmo = sair.
// Lock: só o assunto (FOR UPDATE).
@Injectable()
export class LeaveConversationUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly departure: ConversationDeparture,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  leave(actor: Actor, spaceId: string, conversationId: string): Promise<void> {
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const { scope, conversation } = await this.access.lockForUser(
        spaceId,
        conversationId,
        actor,
      );
      await this.departure.depart(scope, conversation, actor.userId, {
        now: new Date(),
        actorId: actor.userId,
      });
    });
  }

  remove(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    targetUserId: string,
  ): Promise<void> {
    if (targetUserId === actor.userId) {
      return this.leave(actor, spaceId, conversationId);
    }
    return this.uow.run(async () => {
      await this.uow.setContext({ userId: actor.userId });
      const { scope, conversation } = await this.access.lockForUser(
        spaceId,
        conversationId,
        actor,
      );
      conversation.assertOwner(actor.userId);
      await this.departure.depart(scope, conversation, targetUserId, {
        now: new Date(),
        actorId: actor.userId,
      });
      await this.audit.record({
        organizationId: scope.organizationId,
        userId: actor.userId,
        action: 'conversation.participant_removed',
        metadata: {
          conversationId: conversation.id,
          spaceId,
          targetUserId,
        },
      });
    });
  }
}
