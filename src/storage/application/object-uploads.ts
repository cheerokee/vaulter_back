import type { ObjectStore } from './ports/object-store.js';

// Peça compartilhada do mecanismo de envio do storage (intenção -> PUT assinado -> confirmação com HEAD e cópia no
// servidor -> diário -> reparo), exportada pela `application/` para outro índice do MESMO bucket reaproveitar sem
// importar a `infra/` nem o domínio do backup (hoje: os anexos dos assuntos, módulo `conversations`). O backup usa as
// mesmas funções; mudar uma regra aqui muda as duas.
// O resto do mecanismo já é exportado onde nasce: a porta `ObjectStore` (`ports/object-store.ts`, provida pelo
// `StorageModule`), o diário (`journal.ts`: `assertStillMarked`), os erros (`storage-errors.ts`: `storageBusy`,
// `lockTimeoutAsBusy`) e a idade da varredura (`reconcile-storage.use-case.ts`: `RECONCILE_DEFAULT_AGE_MINUTES`).

export {
  INDEX_TAIL_TIMEOUT_MS,
  PRESIGNED_URL_TTL_SECONDS,
  STORAGE_LOCK_TIMEOUT_MS,
  UPLOAD_WINDOW_MS,
} from '../domain/backup-limits.js';
export {
  isUploadedAsDeclared,
  type UploadedBlob,
} from '../domain/backup-object-version.js';

/**
 * The repair rule of one key (the index is the truth): permanently removes every S3 version of `key` that no committed
 * index row references (`referenced`), and every delete marker unless `keepDeleteMarkers` (a deleted backup object
 * keeps its markers; the current one hides it). MUST run with the index row of the key locked (every S3 write of the
 * key happens under that lock). Returns how many versions were removed.
 */
export async function removeUnreferencedVersions(
  store: ObjectStore,
  key: string,
  referenced: ReadonlySet<string>,
  options: { keepDeleteMarkers: boolean },
): Promise<number> {
  let removed = 0;
  for (const v of await store.listVersions(key)) {
    if (referenced.has(v.versionId)) continue;
    if (v.isDeleteMarker && options.keepDeleteMarkers) continue;
    await store.deleteVersion(key, v.versionId);
    removed++;
  }
  return removed;
}
