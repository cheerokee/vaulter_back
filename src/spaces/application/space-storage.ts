import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { SpaceRepository } from '../domain/space.repository.js';

// Tamanho reservado do espaço para os outros módulos (o `hubs`, ao instalar um espaço num Hub). Não é checagem de
// autorização: quem chama já passou pelo `SpaceAccess`.
@Injectable()
export class SpaceStorage {
  constructor(private readonly spaces: SpaceRepository) {}

  /**
   * Reads the reserved size with the space row locked `FOR SHARE` until the end of the unit of work (null for a
   * missing space or a malformed id). MUST run inside `UnitOfWork.run`. A resize holds the row `FOR UPDATE`, so an
   * install waits for it and then checks the hub capacity with the NEW size. Lock order: after the Hub, the link and
   * the hub_space row.
   */
  async lockQuota(orgId: string, spaceId: string): Promise<number | null> {
    if (!validate(orgId) || !validate(spaceId)) return null;
    const space = await this.spaces.lockForShare(orgId, spaceId);
    return space?.storageQuotaBytes ?? null;
  }
}
