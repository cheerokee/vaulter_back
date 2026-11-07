import { Injectable } from '@nestjs/common';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { PlatformRoleKey } from '../domain/platform-catalog.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { assertNotLastPlatformAdmin } from '../domain/platform-staff.js';
import {
  requireExistingUser,
  type PlatformRoleChangeInput,
} from './grant-platform-role.use-case.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';

// Retira um papel da plataforma (idempotente: sem o papel, não grava nem audita). Mesma ordem da concessão; a regra
// do último admin é decidida sob `lockAdmins` (FOR UPDATE nas atribuições vivas de platform_admin): duas retiradas
// concorrentes dos dois únicos admins se serializam e a segunda vê só um admin vivo (422 `last-platform-admin`).
@Injectable()
export class RevokePlatformRoleUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly roles: PlatformRoleRepository,
    private readonly audit: PlatformAudit,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly directory: UserDirectory,
    private readonly uow: UnitOfWork,
  ) {}

  async execute(
    actor: Actor,
    targetUserId: string,
    roleKey: PlatformRoleKey,
    input: PlatformRoleChangeInput,
  ): Promise<void> {
    await this.access.require(actor.userId, 'platform.roles.manage');
    await requireExistingUser(this.directory, targetUserId);
    await this.verifier.verify(actor.userId, input.currentAuthProof);
    await this.uow.run(async () => {
      const admins = await this.roles.lockAdmins();
      await this.access.require(actor.userId, 'platform.roles.manage');
      assertNotLastPlatformAdmin(roleKey, targetUserId, admins);
      if (!(await this.roles.revoke(targetUserId, roleKey, new Date()))) return;
      await this.audit.record({
        userId: actor.userId,
        action: 'platform.role.revoked',
        result: 'success',
        targetUserId,
        metadata: { roleKey },
      });
    });
  }
}
