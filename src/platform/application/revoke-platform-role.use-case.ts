import { Injectable } from '@nestjs/common';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { PlatformRoleKey } from '../domain/platform-catalog.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { assertNotLastPlatformAdmin } from '../domain/platform-staff.js';
import { SupportRequestRepository } from '../domain/support-request.repository.js';
import {
  requireExistingUser,
  type PlatformRoleChangeInput,
} from './grant-platform-role.use-case.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';
import { rejectForLostPermission } from './support-request-audit.js';

// Retira um papel da plataforma (idempotente: sem o papel, não grava nem audita). Mesma ordem da concessão; a regra
// do último admin é decidida sob `lockAdmins` (FOR UPDATE nas atribuições vivas de platform_admin): duas retiradas
// concorrentes dos dois únicos admins se serializam e a segunda vê só um admin vivo (422 `last-platform-admin`).
// Se a pessoa fica sem `platform.support.request`, os pedidos pendentes dela (sem decisão) viram `rejected` na
// mesma transação (`requester_lost_permission`, auditado `platform.request.rejected` sem usuário). Ordem de locks:
// admins (FOR UPDATE) -> pedidos da pessoa (FOR UPDATE, em ordem de id), a mesma da decisão (admins FOR SHARE ->
// pedido).
@Injectable()
export class RevokePlatformRoleUseCase {
  constructor(
    private readonly access: PlatformAccess,
    private readonly roles: PlatformRoleRepository,
    private readonly audit: PlatformAudit,
    private readonly verifier: CurrentAuthProofVerifier,
    private readonly directory: UserDirectory,
    private readonly uow: UnitOfWork,
    private readonly requests: SupportRequestRepository,
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
      const now = new Date();
      if (!(await this.roles.revoke(targetUserId, roleKey, now))) return;
      await this.audit.record({
        userId: actor.userId,
        action: 'platform.role.revoked',
        result: 'success',
        targetUserId,
        metadata: { roleKey },
      });
      if (await this.access.has(targetUserId, 'platform.support.request')) {
        return;
      }
      for (const request of await this.requests.lockPendingOf(targetUserId)) {
        await rejectForLostPermission(request, now, this.requests, this.audit);
      }
    });
  }
}
