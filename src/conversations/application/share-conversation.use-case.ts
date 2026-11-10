import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import {
  DomainValidationError,
  NotFoundError,
} from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceAccess } from '../../spaces/application/space-access.js';
import {
  conversationNotFound,
  participantNotSpaceMember,
} from '../domain/conversation-errors.js';
import {
  assertShareCoversSpace,
  assertVersionsCovered,
} from '../domain/conversation-keys.js';
import { ConversationKeyGrantRepository } from '../domain/conversation-key-grant.repository.js';
import { ConversationParticipantRepository } from '../domain/conversation-participant.repository.js';
import { assertParticipantCapacity } from '../domain/participation-rules.js';
import { assertWrappedConversationKey } from '../domain/wrapped-conversation-key.js';
import { ConversationAccess } from './conversation-access.js';
import { ConversationViews } from './conversation-views.js';
import type { ConversationView } from './dto/conversation-view.js';

export type ShareTarget = {
  userId: string;
  /** Every version 1..current sealed for the person. */
  grants: { keyVersion: number; wrappedKey: string }[];
};

/**
 * `people`: the given members of the space (who already participates is skipped). `space`: "share with the space",
 * exactly the people of the space who do not participate yet (409 `conversation-share-mismatch` otherwise).
 */
export type ShareMode = 'people' | 'space';

// Compartilhar (spec §4.2): QUALQUER participante põe pessoas, que precisam ser membros do espaço (todo papel do
// espaço tem `memory.read`; não membro: 422 `participant-not-space-member`), com as cópias de TODAS as versões
// (409 `key-versions-mismatch`), até 50 participantes (409 `conversation-participant-limit`). Auditado
// (`conversation.shared`, só ids). Locks: espaço (FOR SHARE: tirar alguém do espaço trava FOR UPDATE antes das
// lápides, então o "é membro" vale até o commit) -> assunto (FOR UPDATE).
@Injectable()
export class ShareConversationUseCase {
  constructor(
    private readonly access: ConversationAccess,
    private readonly spaces: SpaceAccess,
    private readonly participants: ConversationParticipantRepository,
    private readonly grants: ConversationKeyGrantRepository,
    private readonly views: ConversationViews,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    conversationId: string,
    targets: ShareTarget[],
    mode: ShareMode,
  ): Promise<ConversationView> {
    const { userId } = actor;
    for (const t of targets) {
      for (const g of t.grants) assertWrappedConversationKey(g.wrappedKey);
    }
    const sent = targets.map((t) => t.userId);
    if (mode === 'people' && new Set(sent).size !== sent.length) {
      throw new DomainValidationError(
        'duplicate-participant',
        'Each participant appears once.',
      );
    }
    return this.uow.run(async () => {
      await this.uow.setContext({ userId });
      const scope = await this.access.userScope(spaceId, userId);
      const { organizationId } = scope;
      try {
        await this.spaces.lockAsMember(
          spaceId,
          userId,
          'memory.read',
          undefined,
          'share',
        );
      } catch (e) {
        if (e instanceof NotFoundError) throw conversationNotFound();
        throw e;
      }
      const conversation = await this.access.lock(
        scope,
        conversationId,
        spaceId,
      );
      const live = new Set(
        (await this.participants.listLive(scope, conversation.id)).map(
          (p) => p.userId,
        ),
      );
      if (mode === 'space') {
        const members = await this.spaces.spaceMemberIds(
          organizationId,
          spaceId,
        );
        assertShareCoversSpace(
          sent,
          members.filter((m) => !live.has(m)),
        );
      }
      const newcomers = targets.filter((t) => !live.has(t.userId));
      for (const t of newcomers) {
        if (
          !(await this.spaces.isSpaceMember(organizationId, spaceId, t.userId))
        ) {
          throw participantNotSpaceMember();
        }
      }
      assertParticipantCapacity(live.size, newcomers.length);
      for (const t of newcomers) {
        assertVersionsCovered(
          t.grants.map((g) => g.keyVersion),
          conversation.currentKeyVersion,
        );
      }
      const now = new Date();
      for (const t of newcomers) {
        await this.participants.add(scope, conversation.id, t.userId, now);
        for (const g of t.grants) {
          await this.grants.put(scope, conversation.id, {
            keyVersion: g.keyVersion,
            recipient: { kind: 'user', userId: t.userId },
            wrappedKey: g.wrappedKey,
          });
        }
      }
      if (newcomers.length > 0) {
        await this.audit.record({
          organizationId,
          userId,
          action: 'conversation.shared',
          metadata: {
            conversationId: conversation.id,
            spaceId,
            userIds: newcomers.map((t) => t.userId),
            withSpace: mode === 'space',
          },
        });
      }
      return this.views.reload(scope, conversation.id);
    });
  }
}
