import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { PendingGrantRepository } from '../domain/pending-grant.repository.js';
import type { PendingGrantView } from './dto/pending-grant-view.js';
import { SpaceAccess } from './space-access.js';

// Pendências de trancar do espaço (Gestor), com a publicKey de cada pessoa para o app trancar a chave.
@Injectable()
export class ListPendingGrantsUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly pending: PendingGrantRepository,
    private readonly users: UserDirectory,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<PendingGrantView>> {
    const { space } = await this.access.requireSpacePermission(
      spaceId,
      actor.userId,
      'space.members.manage',
    );
    const result = await this.pending.listPending(
      space.organizationId,
      space.id,
      page,
    );
    const users = new Map(
      (await this.users.findPublicByIds(result.items.map((i) => i.userId))).map(
        (u) => [u.id, u],
      ),
    );
    const items: PendingGrantView[] = [];
    for (const grant of result.items) {
      const user = users.get(grant.userId);
      if (!user) continue;
      items.push({
        id: grant.id,
        userId: grant.userId,
        name: user.name,
        email: user.email,
        publicKey: user.publicKey,
        roleKey: grant.roleKey,
        invitationId: grant.invitationId,
        requestedByUserId: grant.requestedByUserId,
        createdAt: grant.createdAt,
      });
    }
    return { items, nextCursor: result.nextCursor };
  }
}
