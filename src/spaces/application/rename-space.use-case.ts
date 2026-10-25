import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { AuditLog } from '../../organizations/application/audit-log.js';
import { UnitOfWork } from '../../shared/infra/db/unit-of-work.js';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';
import { toSpaceView, type SpaceView } from './dto/space-view.js';
import { RecoveryKit } from './recovery-kit.js';
import { SpaceAccess } from './space-access.js';

// Renomeia (Gestor). Com o espaço travado: `save` grava a linha inteira (inclusive a versão da chave), então não
// pode partir de uma leitura velha enquanto uma troca de chave corre.
@Injectable()
export class RenameSpaceUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly kit: RecoveryKit,
    private readonly spaces: SpaceRepository,
    private readonly keys: SpaceKeyRepository,
    private readonly audit: AuditLog,
    private readonly uow: UnitOfWork,
  ) {}

  execute(
    actor: Actor,
    spaceId: string,
    input: { name: string },
  ): Promise<SpaceView> {
    return this.uow.run(async () => {
      const { space, roleKey } = await this.access.lockAsMember(
        spaceId,
        actor.userId,
        'space.members.manage',
      );
      space.rename(input.name);
      await this.spaces.save(space);
      await this.audit.record({
        organizationId: space.organizationId,
        userId: actor.userId,
        action: 'space.renamed',
        metadata: { spaceId: space.id },
      });
      // Relida depois do save (ainda sob o lock): o updated_at é o que o banco gravou, não o da leitura.
      const saved =
        (await this.spaces.findById(space.organizationId, space.id)) ?? space;
      const versions = await this.keys.versions(space.organizationId, space.id);
      return toSpaceView(
        saved,
        roleKey,
        await this.kit.isRewrapRequired(space.organizationId, versions),
      );
    });
  }
}
