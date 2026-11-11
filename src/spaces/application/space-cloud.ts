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
}
