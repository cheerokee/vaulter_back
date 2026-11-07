import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { PlatformRoleKey } from '../domain/platform-catalog.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { PlatformAccess } from './platform-access.js';

export type StaffMemberView = {
  userId: string;
  name: string;
  email: string;
  roles: PlatformRoleKey[];
};

@Injectable()
export class ListStaffUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly roles: PlatformRoleRepository,
    private readonly directory: UserDirectory,
  ) {}

  async execute(
    actor: Actor,
    page: CursorPageRequest,
  ): Promise<CursorPage<StaffMemberView>> {
    await this.access.require(actor.userId, 'platform.roles.manage');
    const result = await this.roles.listStaff(page);
    const users = new Map(
      (
        await this.directory.findPublicByIds(result.items.map((i) => i.userId))
      ).map((u) => [u.id, u]),
    );
    const items: StaffMemberView[] = [];
    for (const staff of result.items) {
      const user = users.get(staff.userId);
      // Usuário não é apagado fisicamente; sem ele no diretório, não há o que mostrar.
      if (!user) continue;
      items.push({
        userId: staff.userId,
        name: user.name,
        email: user.email,
        roles: staff.roles,
      });
    }
    return { items, nextCursor: result.nextCursor };
  }
}
