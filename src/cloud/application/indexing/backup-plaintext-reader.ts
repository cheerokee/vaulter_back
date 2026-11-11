import { Injectable } from '@nestjs/common';
import {
  BackupContentReader,
  type LiveObjectVersion,
} from '../../../storage/application/backup-content-reader.js';
import { BackupObjectOpener } from '../ports/backup-object-opener.js';
import type { SpaceKeys } from './space-keys.js';

// Lê e abre objetos do backup de um espaço em nuvem ativa: os bytes cifrados da versão que o índice diz
// (`BackupContentReader`, conferidos pelo sha256) e a decifragem com a chave da versão (`SpaceKeys`). O texto em claro
// é de quem chama, que o apaga quando termina. Quem chama já conferiu que o espaço está em `active_cloud`.
@Injectable()
export class BackupPlaintextReader {
  constructor(
    private readonly content: BackupContentReader,
    private readonly opener: BackupObjectOpener,
  ) {}

  liveVersions(
    organizationId: string,
    spaceId: string,
    objectIds: readonly string[],
  ): Promise<Map<string, LiveObjectVersion>> {
    return this.content.liveVersions(organizationId, spaceId, objectIds);
  }

  async open(
    organizationId: string,
    spaceId: string,
    version: LiveObjectVersion,
    keys: SpaceKeys,
    maxBlobBytes: number,
  ): Promise<Uint8Array> {
    const blob = await this.content.read(
      organizationId,
      spaceId,
      version,
      maxBlobBytes,
    );
    return this.opener.open(
      await keys.get(version.keyVersion),
      { spaceId, objectId: version.objectId, keyVersion: version.keyVersion },
      blob,
    );
  }
}
