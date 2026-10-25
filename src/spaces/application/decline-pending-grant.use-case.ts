import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { PendingGrantRepository } from '../domain/pending-grant.repository.js';
import { SpaceAccess } from './space-access.js';

// Recusa uma pendência de trancar aberta, pelo id (só se for deste espaço). Gestor.
@Injectable()
export class DeclinePendingGrantUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly pending: PendingGrantRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    pendingGrantId: string,
  ): Promise<void> {
    return this.uow.run(async () => {
      const { space } = await this.access.requireSpacePermission(
        spaceId,
        actor.userId,
        'space.members.manage',
      );
      const targetUserId = validate(pendingGrantId)
        ? await this.pending.decline(
            space.organizationId,
            space.id,
            pendingGrantId,
          )
        : null;
      if (!targetUserId) {
        throw new NotFoundError(
          'pending-grant-not-found',
          'The pending grant was not found.',
        );
      }
      await this.audit.record({
        organizationId: space.organizationId,
        userId: actor.userId,
        action: 'space.pending_grant_declined',
        metadata: { spaceId: space.id, pendingGrantId, targetUserId },
      });
    });
  }
}
