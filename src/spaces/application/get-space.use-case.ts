import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { toSpaceView, type SpaceView } from './dto/space-view.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';

// Detalhes do espaço, só para membro (o admin fora do espaço recebe 404). As pendências de trancar ficam na
// rota própria (`ListPendingGrantsUseCase`).
@Injectable()
export class GetSpaceUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly keys: SpaceKeyRepository,
  ) {}

  async execute(actor: Actor, spaceId: string): Promise<SpaceView> {
    const { space, roleKey } = await this.access.requireSpaceMember(
      spaceId,
      actor.userId,
    );
    const versions = await this.keys.versions(space.organizationId, space.id);
    return toSpaceView(
      space,
      roleKey,
      await this.kit.isRewrapRequired(space.organizationId, versions),
    );
  }
}
