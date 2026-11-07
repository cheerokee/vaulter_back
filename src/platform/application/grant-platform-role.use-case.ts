import { Injectable } from '@nestjs/common';
import { CurrentAuthProofVerifier } from '../../identity/application/current-auth-proof-verifier.js';
import type { Actor } from '../../identity/application/dto/actor.js';
import { UserDirectory } from '../../identity/application/user-directory.js';
import { NotFoundError } from '../../shared/domain/errors.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import type { PlatformRoleKey } from '../domain/platform-catalog.js';
import { PlatformRoleRepository } from '../domain/platform-role.repository.js';
import { PlatformAccess } from './platform-access.js';
import { PlatformAudit } from './platform-audit.js';

export type PlatformRoleChangeInput = { currentAuthProof: string };

export async function requireExistingUser(
  directory: UserDirectory,
  userId: string,
): Promise<void> {
  if ((await directory.findPublicByIds([userId])).length === 0) {
    throw new NotFoundError('user-not-found', 'The user was not found.');
  }
}

// Dá um papel da plataforma (idempotente: já tendo, não grava nem audita). Ordem:
// 1. permissão (404 sem `platform.roles.manage`) e conta-alvo (404), sem gastar o Argon2;
// 2. reautenticação FORA da transação, para não segurar conexão no Argon2;
// 3. na transação: trava os admins (serializa com as retiradas), reconfere a permissão sob o lock, grava e audita.
@Injectable()
export class GrantPlatformRoleUseCase {
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
      await this.roles.lockAdmins();
      await this.access.require(actor.userId, 'platform.roles.manage');
      if (!(await this.roles.grant(targetUserId, roleKey, new Date()))) return;
      await this.audit.record({
        userId: actor.userId,
        action: 'platform.role.granted',
        result: 'success',
        targetUserId,
        metadata: { roleKey },
      });
    });
  }
}
