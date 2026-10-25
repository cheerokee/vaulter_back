import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import type { SpaceMemberView } from './dto/space-member-view.js';
import { SpaceAccess } from './space-access.js';

@Injectable()
export class ListSpaceMembersUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly roles: SpaceRoleRepository,
    private readonly users: UserDirectory,
  ) {}

  async execute(
    actor: Actor,
    spaceId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceMemberView>> {
    const { space } = await this.access.requireSpaceMember(
      spaceId,
      actor.userId,
    );
    const result = await this.roles.listMembers(
      space.organizationId,
      space.id,
      page,
    );
    const users = new Map(
      (await this.users.findPublicByIds(result.items.map((i) => i.userId))).map(
        (u) => [u.id, u],
      ),
    );
    const items: SpaceMemberView[] = [];
    for (const member of result.items) {
      const user = users.get(member.userId);
      // Usuário não é apagado fisicamente; sem ele no diretório, não há o que mostrar.
      if (!user) continue;
      items.push({
        userId: member.userId,
        name: user.name,
        email: user.email,
        publicKey: user.publicKey,
        roleKey: member.roleKey,
        joinedAt: member.joinedAt,
      });
    }
    return { items, nextCursor: result.nextCursor };
  }
}
