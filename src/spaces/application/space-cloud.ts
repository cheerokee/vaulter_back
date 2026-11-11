import { Injectable } from '@nestjs/common';
import { SpaceKeyRepository } from '../domain/space-key.repository.js';
import { SpaceRepository } from '../domain/space.repository.js';

export type SpaceKeyVersionRef = { id: string; version: number };

// O modo de nuvem do espaço, para o módulo `cloud` (spec active-cloud §4.1): o `spaces` guarda `cloud_mode` e
// `cloud_activated_at` (todo membro os vê em `GET /spaces/:id`), mas só o fluxo de ligar/desligar do `cloud` os muda,
// por aqui. Não é checagem de autorização: quem chama já passou pelo `SpaceAccess` (`lockAsMember` /
// `lockWithOrgPermission`) e segura a linha do espaço `FOR UPDATE` no mesmo unit of work.
@Injectable()
export class SpaceCloud {
  constructor(
    private readonly spaces: SpaceRepository,
    private readonly keys: SpaceKeyRepository,
  ) {}

  /** Every key version of the space (ascending), to require the server copy of each one. Trusted read. */
  async keyVersions(
    organizationId: string,
    spaceId: string,
  ): Promise<SpaceKeyVersionRef[]> {
    return (await this.keys.versions(organizationId, spaceId)).map((k) => ({
      id: k.id,
      version: k.version,
    }));
  }

  /** `active_cloud` since `at`. The caller holds the space `FOR UPDATE`. */
  async markActive(
    organizationId: string,
    spaceId: string,
    at: Date,
  ): Promise<void> {
    await this.spaces.setCloudMode(organizationId, spaceId, 'active_cloud', at);
  }

  /** Back to `encrypted_backup`. The caller holds the space `FOR UPDATE`. */
  async markEncryptedBackup(
    organizationId: string,
    spaceId: string,
  ): Promise<void> {
    await this.spaces.setCloudMode(
      organizationId,
      spaceId,
      'encrypted_backup',
      null,
    );
  }

  /**
   * The cloud mode of the space, read without a lock (null for an unknown space). For hooks that run while the caller
   * already holds the space row (e.g. the backup's `FOR SHARE`), so the mode cannot change underneath. Trusted read.
   */
  async modeOf(
    organizationId: string,
    spaceId: string,
  ): Promise<'encrypted_backup' | 'active_cloud' | null> {
    const space = await this.spaces.findById(organizationId, spaceId);
    return space ? space.cloudMode : null;
  }

  /**
   * Locks the space row `FOR SHARE` and tells whether it is in `active_cloud` (false for an unknown space). The cloud's
   * background jobs call it in the SAME transaction that writes anything legible, right before writing: switching
   * off takes the row `FOR UPDATE`, so a job that sees `true` here writes before the switch-off can start, and one
   * that waits behind a switch-off sees `false` and writes nothing. REQUIRES a unit of work. Trusted (no actor).
   */
  async lockActiveForWrite(
    organizationId: string,
    spaceId: string,
  ): Promise<boolean> {
    const space = await this.spaces.lockForShare(organizationId, spaceId);
    return space?.cloudMode === 'active_cloud';
  }
}
