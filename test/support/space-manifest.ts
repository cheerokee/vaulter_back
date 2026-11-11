import type { INestApplication } from '@nestjs/common';
import { newId } from '../../src/shared/domain/id.js';
import {
  cloudManifestObjectId,
  hubManifestObjectId,
} from '../../src/shared/domain/space-manifest-ids.js';
import { sealSpaceKey } from './client-crypto.js';
import { sealBackupObject, sha256Hex } from './hub-crypto.js';
import {
  expectStatus,
  identityClient,
  type KeyedUser,
} from './identity-client.js';

// O Hub simulado da nuvem ativa (contrato docs/hubs/space-manifest.md): cifra arquivos e o manifesto no formato do
// backup (docs/crypto/space-backup.md) e sobe pelas rotas reais do backup (`/spaces/:spaceId/backup/...`, sessão de um
// Gestor/editor, o mesmo caso de uso das rotas do Hub), e liga/desliga a nuvem pelas rotas reais. Até o
// `vaulter-hub-back` implementar o contrato, é a referência executável dele.

export { cloudManifestObjectId, hubManifestObjectId };

/** One file of the simulated Hub: its manifest entry and the live version of each part. */
export type SimFile = {
  fileId: string;
  name: string;
  mediaType: string;
  source: Record<string, string>;
  parts: { objectId: string; versionId: string }[];
};

/** `0x01 ‖ UTF-8 JSON` (the manifest plaintext). */
export function manifestPlaintext(
  spaceId: string,
  writer: 'hub' | 'cloud',
  files: readonly SimFile[],
): Uint8Array {
  const json = JSON.stringify({
    spaceId,
    writer,
    updatedAt: new Date().toISOString(),
    files: files.map((f) => ({
      fileId: f.fileId,
      name: f.name,
      path: null,
      mediaType: f.mediaType,
      source: f.source,
      modifiedAt: new Date().toISOString(),
      parts: f.parts.map((p) => p.objectId),
    })),
  });
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(1 + body.length);
  out[0] = 0x01;
  out.set(body, 1);
  return out;
}

export function simulatedHub(getApp: () => INestApplication) {
  const c = identityClient(getApp);
  const auth = (u: KeyedUser) => c.bearer(u.token);

  /** Encrypts and uploads one object (intent, PUT to S3, confirm); returns the committed versionId. */
  const putObject = async (
    u: KeyedUser,
    space: { spaceId: string; key: Uint8Array; keyVersion?: number },
    objectId: string,
    plaintext: Uint8Array,
    replacesVersionId: string | null,
  ): Promise<string> => {
    const keyVersion = space.keyVersion ?? 1;
    const blob = await sealBackupObject(
      space.key,
      { spaceId: space.spaceId, objectId, keyVersion },
      plaintext,
    );
    const intent = await expectStatus(
      c
        .http()
        .post(`/spaces/${space.spaceId}/backup/uploads`)
        .set(auth(u))
        .send({
          items: [
            {
              objectId,
              keyVersion,
              sizeBytes: blob.length,
              sha256: await sha256Hex(blob),
              replacesVersionId,
            },
          ],
        }),
      201,
    );
    const item = intent.body.items[0] as {
      uploadId: string;
      url: string;
      headers: Record<string, string>;
    };
    const put = await fetch(item.url, {
      method: 'PUT',
      headers: item.headers,
      body: new Uint8Array(blob),
    });
    if (put.status !== 200) throw new Error(`PUT ${put.status}`);
    const confirm = await expectStatus(
      c
        .http()
        .post(`/spaces/${space.spaceId}/backup/uploads/confirm`)
        .set(auth(u))
        .send({ uploadIds: [item.uploadId] }),
      200,
    );
    return confirm.body.items[0].versionId as string;
  };

  const deleteObject = async (
    u: KeyedUser,
    spaceId: string,
    objectId: string,
    versionId: string,
  ): Promise<void> => {
    await expectStatus(
      c
        .http()
        .post(`/spaces/${spaceId}/backup/objects/delete`)
        .set(auth(u))
        .send({ items: [{ objectId, replacesVersionId: versionId }] }),
      204,
    );
  };

  /** A Hub's view of one space: its files and its manifest, kept in sync with the backup. */
  const forSpace = (
    u: KeyedUser,
    space: { spaceId: string; key: Uint8Array },
  ) => {
    const files = new Map<string, SimFile>();
    let manifestVersion: string | null = null;

    const writeManifest = async () => {
      manifestVersion = await putObject(
        u,
        space,
        hubManifestObjectId(space.spaceId),
        manifestPlaintext(space.spaceId, 'hub', [...files.values()]),
        manifestVersion,
      );
    };

    /** Splits `bytes` into `parts` objects (in order), uploads them, then the manifest listing the file. */
    const addFile = async (
      name: string,
      mediaType: string,
      bytes: Uint8Array,
      options: { parts?: number; source?: Record<string, string> } = {},
    ): Promise<SimFile> => {
      const n = options.parts ?? 1;
      const size = Math.ceil(bytes.length / n);
      const parts: SimFile['parts'] = [];
      for (let i = 0; i < n; i += 1) {
        const objectId = newId();
        parts.push({
          objectId,
          versionId: await putObject(
            u,
            space,
            objectId,
            bytes.subarray(i * size, (i + 1) * size),
            null,
          ),
        });
      }
      const file: SimFile = {
        fileId: newId(),
        name,
        mediaType,
        source: options.source ?? { kind: 'file' },
        parts,
      };
      files.set(file.fileId, file);
      await writeManifest();
      return file;
    };

    /** New content for a single-part file: a new version of its object (the manifest does not change). */
    const replaceContent = async (fileId: string, bytes: Uint8Array) => {
      const file = files.get(fileId)!;
      const part = file.parts[0]!;
      part.versionId = await putObject(
        u,
        space,
        part.objectId,
        bytes,
        part.versionId,
      );
    };

    /** Deletes the file's objects and writes the manifest without it. */
    const removeFile = async (fileId: string) => {
      const file = files.get(fileId)!;
      for (const p of file.parts) {
        await deleteObject(u, space.spaceId, p.objectId, p.versionId);
      }
      files.delete(fileId);
      await writeManifest();
    };

    return { files, addFile, replaceContent, removeFile, writeManifest };
  };

  return { putObject, deleteObject, forSpace };
}

/** Switching the cloud on and off through the real routes (term, authorize, activate with every version, deactivate). */
export function cloudSwitch(getApp: () => INestApplication) {
  const c = identityClient(getApp);
  const auth = (u: KeyedUser) => c.bearer(u.token);
  return {
    /** Accepts the current term (if needed), authorizes and activates with `keys[i]` = version i + 1. */
    switchOn: async (
      u: KeyedUser,
      orgId: string,
      spaceId: string,
      keys: Uint8Array[],
    ) => {
      const terms = await expectStatus(
        c.http().get(`/organizations/${orgId}/cloud/terms`).set(auth(u)),
        200,
      );
      const cur = terms.body.current as { version: number; hash: string };
      await expectStatus(
        c
          .http()
          .post(`/organizations/${orgId}/cloud/terms/accept`)
          .set(auth(u))
          .send({ version: cur.version, hash: cur.hash }),
        200,
      );
      await expectStatus(
        c
          .http()
          .post(`/spaces/${spaceId}/cloud/authorize`)
          .set(auth(u))
          .send({}),
        200,
      );
      const serverPk = await c.spaces.serverPublicKey(u.token);
      await expectStatus(
        c
          .http()
          .post(`/spaces/${spaceId}/cloud/activate`)
          .set(auth(u))
          .send({
            serverGrants: await Promise.all(
              keys.map(async (key, i) => ({
                version: i + 1,
                wrappedKey: await sealSpaceKey(key, serverPk),
              })),
            ),
          }),
        200,
      );
    },
    switchOff: async (u: KeyedUser, spaceId: string) => {
      await expectStatus(
        c
          .http()
          .post(`/spaces/${spaceId}/cloud/deactivate`)
          .set(auth(u))
          .send({}),
        204,
      );
    },
  };
}
