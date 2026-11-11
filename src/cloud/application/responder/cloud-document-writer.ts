import { Injectable, Logger } from '@nestjs/common';
import {
  cloudManifestObjectId,
  hubManifestObjectId,
} from '../../../shared/domain/space-manifest-ids.js';
import { SpaceCloud } from '../../../spaces/application/space-cloud.js';
import type { LiveObjectVersion } from '../../../storage/application/backup-content-reader.js';
import { ServerBackupWriter } from '../../../storage/application/server-backup-writer.js';
import { MANIFEST_MAX_BYTES } from '../../domain/indexing-limits.js';
import { documentObjectIdFor } from '../../domain/responder.js';
import {
  parseSpaceManifest,
  serializeSpaceManifest,
  type ManifestFile,
  type ManifestWriter,
} from '../../domain/space-manifest.js';
import { BackupPlaintextReader } from '../indexing/backup-plaintext-reader.js';
import { CloudIndexingQueue } from '../indexing/cloud-indexing-queue.js';
import { SpaceKeyOpener, type SpaceKeys } from '../indexing/space-keys.js';
import { CloudCipher } from '../ports/cloud-cipher.js';

/** A document the cloud records (spec active-cloud §4.3): legible, never logged. */
export type CloudDocument = {
  /** UUID v7: the proposal id (stable: recording twice is a no-op). */
  fileId: string;
  title: string;
  /** Markdown. */
  content: string;
};

/** The cloud manifest of the space cannot be read (it must be valid to be rewritten): nothing is written. */
export class CloudManifestUnreadableError extends Error {
  constructor() {
    super('the cloud manifest cannot be read');
    this.name = 'CloudManifestUnreadableError';
  }
}

const MAX_NAME_CHARS = 255;

/** `<title>.md`, at most 255 characters (the manifest's name rule). */
export function documentName(title: string): string {
  const base = title.trim().replace(/\s+/g, ' ') || 'Documento';
  return `${base.slice(0, MAX_NAME_CHARS - 3)}.md`;
}

// Grava um documento da nuvem no espaço (spec active-cloud §4.2 "Manifesto da nuvem" e §4.3 "Documentar"; contrato em
// docs/hubs/space-manifest.md): o arquivo vira UM objeto do backup (UUID v7 derivado do `fileId`, cifrado com a versão
// ATUAL da chave do espaço, docs/crypto/space-backup.md) e uma entrada no manifesto da NUVEM (`writer: "cloud"`,
// `source: { kind: "cloud" }`), escrito só por aqui. Os dois sobem numa gravação só do servidor (`ServerBackupWriter`:
// intenção + PUT + confirmação, contando no tamanho do espaço; 422 `space-storage-full` sem espaço; 409 com troca de chave
// pendente), em nome da PESSOA que confirmou (precisa de `memory.write` no espaço) e com a guarda "espaço ainda em nuvem
// ativa" conferida sob a trava do espaço nas duas transações (desligou no meio = nada gravado). Na mesma reescrita do
// manifesto da nuvem saem as entradas que o Hub já incorporou ao manifesto dele (passo 4 da incorporação). Depois, a
// indexação do espaço é enfileirada para JÁ (sem a espera de 2 s): o documento entra no índice na hora.
// Idempotente: o `fileId` já listado (no da nuvem ou no do Hub) não grava de novo. Concorrência no manifesto: a
// gravação substitui a versão lida (`replacesVersionId`); outra gravação no meio = 409 `object-version-conflict` e o
// job tenta de novo. A chave aberta e os textos em claro são apagados no fim.
@Injectable()
export class CloudDocumentWriter {
  private readonly logger = new Logger(CloudDocumentWriter.name);

  constructor(
    private readonly keyOpener: SpaceKeyOpener,
    private readonly reader: BackupPlaintextReader,
    private readonly cipher: CloudCipher,
    private readonly writer: ServerBackupWriter,
    private readonly spaceCloud: SpaceCloud,
    private readonly queue: CloudIndexingQueue,
  ) {}

  async record(input: {
    organizationId: string;
    spaceId: string;
    onBehalfOfUserId: string;
    document: CloudDocument;
    now: Date;
  }): Promise<'recorded' | 'already-recorded'> {
    const { organizationId, spaceId, document } = input;
    const hubId = hubManifestObjectId(spaceId);
    const cloudId = cloudManifestObjectId(spaceId);
    const objectId = documentObjectIdFor(document.fileId);
    const live = await this.reader.liveVersions(organizationId, spaceId, [
      hubId,
      cloudId,
      objectId,
    ]);
    const keyVersions = await this.spaceCloud.keyVersions(
      organizationId,
      spaceId,
    );
    const currentKeyVersion = Math.max(...keyVersions.map((k) => k.version));
    const keys = await this.keyOpener.forSpace(organizationId, spaceId);
    const buffers: Uint8Array[] = [];
    try {
      const hub = await this.readManifest(
        organizationId,
        spaceId,
        'hub',
        live.get(hubId),
        keys,
      );
      const cloud = await this.readManifest(
        organizationId,
        spaceId,
        'cloud',
        live.get(cloudId),
        keys,
      );
      if (cloud === 'invalid') throw new CloudManifestUnreadableError();
      const inHub = new Set(hub === 'invalid' ? [] : hub.map((f) => f.fileId));
      if (
        inHub.has(document.fileId) ||
        cloud.some((f) => f.fileId === document.fileId)
      ) {
        return 'already-recorded';
      }
      const key = await keys.get(currentKeyVersion);
      const content = new TextEncoder().encode(document.content);
      buffers.push(content);
      const entry: ManifestFile = {
        fileId: document.fileId,
        name: documentName(document.title),
        path: null,
        mediaType: 'text/markdown',
        source: { kind: 'cloud' },
        modifiedAt: input.now,
        parts: [objectId],
      };
      // Passo 4 da incorporação: o que o Hub já tem no manifesto dele sai do manifesto da nuvem.
      const kept = cloud.filter((f) => !inHub.has(f.fileId));
      const manifest = serializeSpaceManifest(
        spaceId,
        'cloud',
        [...kept, entry],
        input.now,
      );
      buffers.push(manifest);
      await this.writer.write({
        onBehalfOfUserId: input.onBehalfOfUserId,
        spaceId,
        guard: async (space) =>
          (await this.spaceCloud.modeOf(
            space.organizationId,
            space.spaceId,
          )) === 'active_cloud',
        objects: [
          {
            objectId,
            keyVersion: currentKeyVersion,
            blob: await this.cipher.sealBackupObject(
              key,
              { spaceId, objectId, keyVersion: currentKeyVersion },
              content,
            ),
            replacesVersionId: live.get(objectId)?.versionId ?? null,
          },
          {
            objectId: cloudId,
            keyVersion: currentKeyVersion,
            blob: await this.cipher.sealBackupObject(
              key,
              { spaceId, objectId: cloudId, keyVersion: currentKeyVersion },
              manifest,
            ),
            replacesVersionId: live.get(cloudId)?.versionId ?? null,
          },
        ],
      });
      this.logger.log(
        {
          organizationId,
          spaceId,
          fileId: document.fileId,
          prunedEntries: cloud.length - kept.length,
        },
        'cloud document recorded',
      );
    } finally {
      keys.wipe();
      for (const b of buffers) b.fill(0);
    }
    // The backup hook already queued a pass with the 2 s debounce: this one starts it now (same singleton key).
    await this.queue.enqueueSpace(organizationId, spaceId, { debounce: false });
    return 'recorded';
  }

  private async readManifest(
    organizationId: string,
    spaceId: string,
    writer: ManifestWriter,
    version: LiveObjectVersion | undefined,
    keys: SpaceKeys,
  ): Promise<ManifestFile[] | 'invalid'> {
    if (!version) return [];
    if (version.sizeBytes > MANIFEST_MAX_BYTES) return 'invalid';
    let plaintext: Uint8Array | undefined;
    try {
      plaintext = await this.reader.open(
        organizationId,
        spaceId,
        version,
        keys,
        MANIFEST_MAX_BYTES,
      );
      return parseSpaceManifest(plaintext, { spaceId, writer }).files;
    } catch {
      return 'invalid';
    } finally {
      plaintext?.fill(0);
    }
  }
}
