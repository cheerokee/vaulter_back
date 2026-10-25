import { Injectable } from '@nestjs/common';
import type { Actor } from '../../identity/application/dto/actor.js';
import { SpaceGrantRepository } from '../domain/space-grant.repository.js';
import type { MyKeysView } from './dto/my-keys-view.js';
import { SpaceAccess } from './space-access.js';

// Minhas cópias trancadas (todas as versões) e a versão atual. Só membro; o admin fora do espaço recebe 404.
@Injectable()
export class GetMyKeysUseCase {
  constructor(
    private readonly access: SpaceAccess,
    private readonly grants: SpaceGrantRepository,
  ) {}

  async execute(actor: Actor, spaceId: string): Promise<MyKeysView> {
    const { space } = await this.access.requireSpaceMember(
      spaceId,
      actor.userId,
    );
    const grants = await this.grants.forUser(
      space.organizationId,
      space.id,
      actor.userId,
    );
    return {
      currentVersion: space.currentKeyVersion,
      keys: grants.map((g) => ({
        version: g.version,
        wrappedKey: g.wrappedKey,
      })),
    };
  }
}
