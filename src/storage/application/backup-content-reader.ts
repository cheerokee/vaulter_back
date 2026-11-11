import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { objectKey } from '../domain/backup-keys.js';
import {
  BackupIndexReader,
  type LiveObjectVersion,
} from './ports/backup-index-reader.js';
import { ObjectStore } from './ports/object-store.js';

export type { LiveObjectVersion } from './ports/backup-index-reader.js';

const LIVE_VERSIONS_BATCH = 1000;

/** The bytes read do not match the sha256 the index recorded (bucket and index disagree). Never carries the bytes. */
export class BackupContentMismatchError extends Error {
  constructor(readonly objectId: string) {
    super(`backup object ${objectId}: bytes do not match the index`);
    this.name = 'BackupContentMismatchError';
  }
}

// Leitura do backup CIFRADO pelo próprio servidor, exportada para o `cloud` (nuvem ativa, spec active-cloud §4.2): o
// `storage` entrega ids, versões e bytes cifrados; quem abre (com a chave do espaço) é o `cloud`. NÃO é checagem de
// autorização: quem chama já conferiu que o espaço está em `active_cloud` (o espaço só é lido nesse modo). "O índice é
// a verdade": sempre a versão gravada no índice (`s3VersionId`), nunca a "atual" do S3, e os bytes são conferidos
// contra o sha256 do índice. Sem trava e fora de unit of work (leituras no escopo RLS da organização).
@Injectable()
export class BackupContentReader {
  constructor(
    private readonly index: BackupIndexReader,
    private readonly store: ObjectStore,
  ) {}

  /** The live versions of these objects (missing, deleted or unconfirmed ones are absent), keyed by object id. */
  async liveVersions(
    organizationId: string,
    spaceId: string,
    objectIds: readonly string[],
  ): Promise<Map<string, LiveObjectVersion>> {
    const unique = [...new Set(objectIds)];
    const out = new Map<string, LiveObjectVersion>();
    for (let i = 0; i < unique.length; i += LIVE_VERSIONS_BATCH) {
      const rows = await this.index.liveVersions(
        organizationId,
        spaceId,
        unique.slice(i, i + LIVE_VERSIONS_BATCH),
      );
      for (const r of rows) out.set(r.objectId, r);
    }
    return out;
  }

  /**
   * The encrypted blob of exactly this version (the index's `s3VersionId`), checked against the index's sha256
   * (`BackupContentMismatchError` otherwise). `maxBytes` refuses a bigger blob before reading it.
   */
  async read(
    organizationId: string,
    spaceId: string,
    version: LiveObjectVersion,
    maxBytes: number,
  ): Promise<Uint8Array> {
    const blob = await this.store.getVersion(
      objectKey(organizationId, spaceId, version.objectId),
      version.s3VersionId,
      maxBytes,
    );
    const sha256 = createHash('sha256').update(blob).digest('hex');
    if (sha256 !== version.sha256) {
      throw new BackupContentMismatchError(version.objectId);
    }
    return blob;
  }
}
