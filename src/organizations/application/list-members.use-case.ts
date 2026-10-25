import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import { MembershipRepository } from '../domain/membership.repository.js';
import type { MemberView } from './dto/member-view.js';
import { OrganizationAccess } from './organization-access.js';

@Injectable()
export class ListMembersUseCase {
  constructor(
    private readonly access: OrganizationAccess,
    private readonly memberships: MembershipRepository,
    private readonly directory: UserDirectory,
  ) {}

  async execute(
    actor: Actor,
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<MemberView>> {
    await this.access.requireMember(orgId, actor.userId);
    const result = await this.memberships.list(orgId, page);
    const users = new Map(
      (
        await this.directory.findPublicByIds(result.items.map((i) => i.userId))
      ).map((u) => [u.id, u]),
    );
    const items: MemberView[] = [];
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
        joinedAt: member.joinedAt ?? null,
      });
    }
    return { items, nextCursor: result.nextCursor };
  }
}
