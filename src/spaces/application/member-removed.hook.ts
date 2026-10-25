import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { AuditLog } from '../../organizations/application/audit-log.js';
import {
  MemberRemovedHooks,
  type MemberRemovedContext,
} from '../../shared/application/member-removed-hooks.js';
import { PendingGrantRepository } from '../domain/pending-grant.repository.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import { SpaceRoleRepository } from '../domain/space-role.repository.js';
import type { Space } from '../domain/space.js';
import { SpaceRepository } from '../domain/space.repository.js';

const HOOK_NAME = 'spaces.member-removed';

// Saída da organização (decisão 8). Roda dentro do unit of work da remoção/saída; erro desfaz tudo.
// Ordem, para não brigar com as outras operações (que travam o espaço e depois os papéis):
// 1. trava (FOR UPDATE, em ordem de id) os espaços em que a pessoa está;
// 2. lápide nas cópias e nas atribuições de espaço dela na organização;
// 3. se a lápide alcançou um espaço que não estava travado (ex.: uma troca de chave ou uma entrada que
//    terminou entre 1 e 2), trava esse também e repete a lápide: uma cópia da versão nova gravada por uma troca
//    concorrente vira lápide aqui (o UPDATE seguinte enxerga o que já foi confirmado);
// 4. marca a troca de chave pendente nos espaços afetados (a partir da leitura travada), cancela as pendências
//    de trancar dela e audita um `space.member_removed` por espaço.
// Pode deixar espaço sem Gestor ou órfão: é permitido (promover Gestor / reabrir pelo kit).
@Injectable()
export class SpacesMemberRemovedHook implements OnModuleInit, OnModuleDestroy {
  constructor(
    private readonly hooks: MemberRemovedHooks,
    private readonly spaces: SpaceRepository,
    private readonly roles: SpaceRoleRepository,
    private readonly grants: SpaceGrantRepository,
    private readonly pending: PendingGrantRepository,
    private readonly audit: AuditLog,
  ) {}

  onModuleInit(): void {
    this.hooks.register({
      name: HOOK_NAME,
      onMemberRemoved: (ctx) => this.onMemberRemoved(ctx),
    });
  }

  onModuleDestroy(): void {
    this.hooks.unregister(HOOK_NAME);
  }

  async onMemberRemoved(ctx: MemberRemovedContext): Promise<void> {
    const { organizationId: orgId, userId } = ctx;
    const locked = new Map<string, Space | null>();
    const affected = new Set<string>();
    let toLock = await this.roles.spaceIdsOfUser(orgId, userId);
    for (;;) {
      for (const id of [...toLock].sort()) {
        if (!locked.has(id)) {
          locked.set(id, await this.spaces.lockForUpdate(orgId, id));
        }
      }
      const touched = [
        ...(await this.grants.tombstoneUserInOrg(orgId, userId)),
        ...(await this.roles.removeUserInOrg(orgId, userId)),
      ];
      for (const id of touched) affected.add(id);
      toLock = touched.filter((id) => !locked.has(id));
      if (toLock.length === 0) break;
    }
    const reason =
      ctx.reason === 'left' ? 'organization_left' : 'organization_removed';
    for (const id of [...affected].sort()) {
      const space = locked.get(id);
      // Espaço com lápide: nada a marcar.
      if (!space) continue;
      space.markRotationRequired();
      await this.spaces.save(space);
      await this.audit.record({
        organizationId: orgId,
        userId: ctx.actorId,
        action: 'space.member_removed',
        metadata: { spaceId: id, targetUserId: userId, reason },
      });
    }
    await this.pending.cancelForUser(orgId, userId);
  }
}
