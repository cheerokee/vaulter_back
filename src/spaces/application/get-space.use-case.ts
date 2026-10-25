import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { PendingGrantRepository } from '../domain/pending-grant.repository.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { toSpaceView, type SpaceDetailsView } from './dto/space-view.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';

// Detalhes do espaço, só para membro (o admin fora do espaço recebe 404), com as flags e, para o Gestor, a
// contagem de pendências de trancar (como na lista).
@Injectable()
export class GetSpaceUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly keys: SpaceKeyRepository,
    private readonly pending: PendingGrantRepository,
  ) {}

  async execute(actor: Actor, spaceId: string): Promise<SpaceDetailsView> {
    const { space, roleKey } = await this.access.requireSpaceMember(
      spaceId,
      actor.userId,
    );
    const versions = await this.keys.versions(space.organizationId, space.id);
    const view = toSpaceView(
      space,
      roleKey,
      await this.kit.isRewrapRequired(space.organizationId, versions),
    );
    if (roleKey !== 'space_manager') return view;
    return {
      ...view,
      pendingGrants: await this.pending.countPending(
        space.organizationId,
        space.id,
      ),
    };
  }
}
