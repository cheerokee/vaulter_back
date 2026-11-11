import { validate, version } from 'uuid';
import {
  CONNECTOR_MAX_CHARS,
  FILE_MAX_PARTS,
  FILE_NAME_MAX_CHARS,
  FILE_PATH_MAX_CHARS,
  MANIFEST_MAX_FILES,
  MEDIA_TYPE_MAX_CHARS,
} from './indexing-limits.js';

/** First byte of the decrypted manifest (docs/hubs/space-manifest.md); the UTF-8 JSON follows. */
export const MANIFEST_FORMAT_VERSION = 0x01;

export type ManifestWriter = 'hub' | 'cloud';

export type ManifestSource =
  | { kind: 'file' }
  | { kind: 'connector'; connector: string }
  | { kind: 'cloud' };

/** One file of a manifest. Legible (name, path): never logged. */
export type ManifestFile = {
  fileId: string;
  name: string;
  path: string | null;
  /** Lowercase, without parameters (`text/plain; charset=utf-8` -> `text/plain`). */
  mediaType: string;
  source: ManifestSource;
  modifiedAt: Date | null;
  /** Backup object ids of the parts, in order (concatenated after decryption). */
  parts: string[];
};

export type SpaceManifest = {
  writer: ManifestWriter;
  files: ManifestFile[];
  /** Entries refused one by one (invalid or repeated `fileId`): counted, never logged. */
  skippedEntries: number;
};

/** Why a whole manifest was refused (a code, never content). */
export class ManifestFormatError extends Error {
  constructor(readonly reason: string) {
    super(`space manifest refused: ${reason}`);
    this.name = 'ManifestFormatError';
  }
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;
const CONNECTOR = /^[a-z0-9][a-z0-9._-]*$/;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isV7 = (v: unknown): v is string =>
  typeof v === 'string' && validate(v) && version(v) === 7;

function text(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length >= 1 && v.length <= max ? v : null;
}

export function normalizeMediaType(raw: string): string | null {
  const base = raw.split(';')[0]!.trim().toLowerCase();
  return base.length <= MEDIA_TYPE_MAX_CHARS && MEDIA_TYPE.test(base)
    ? base
    : null;
}

function parseSource(v: unknown): ManifestSource | null {
  if (!isRecord(v)) return null;
  if (v.kind === 'file' || v.kind === 'cloud') return { kind: v.kind };
  if (v.kind === 'connector') {
    const connector = text(v.connector, CONNECTOR_MAX_CHARS);
    return connector && CONNECTOR.test(connector)
      ? { kind: 'connector', connector }
      : null;
  }
  return null;
}

function parseFile(v: unknown): ManifestFile | null {
  if (!isRecord(v) || !isV7(v.fileId)) return null;
  const name = text(v.name, FILE_NAME_MAX_CHARS);
  const mediaType =
    typeof v.mediaType === 'string' ? normalizeMediaType(v.mediaType) : null;
  const source = parseSource(v.source);
  if (!name || !mediaType || !source) return null;
  let path: string | null = null;
  if (v.path !== undefined && v.path !== null) {
    path = text(v.path, FILE_PATH_MAX_CHARS);
    if (path === null) return null;
  }
  let modifiedAt: Date | null = null;
  if (v.modifiedAt !== undefined && v.modifiedAt !== null) {
    if (typeof v.modifiedAt !== 'string' || !ISO_UTC.test(v.modifiedAt))
      return null;
    modifiedAt = new Date(v.modifiedAt);
    if (Number.isNaN(modifiedAt.getTime())) return null;
  }
  const parts = v.parts;
  if (
    !Array.isArray(parts) ||
    parts.length < 1 ||
    parts.length > FILE_MAX_PARTS ||
    !parts.every(isV7) ||
    new Set(parts).size !== parts.length
  ) {
    return null;
  }
  return {
    fileId: v.fileId,
    name,
    path,
    mediaType,
    source,
    modifiedAt,
    parts: [...parts],
  };
}

/**
 * Parses a decrypted manifest (`0x01 ‖ UTF-8 JSON`, docs/hubs/space-manifest.md). The whole manifest is refused
 * (`ManifestFormatError`) when the version byte, the JSON, `spaceId`, `writer` or the `files` array are wrong; one bad
 * file entry (or a repeated `fileId`) only drops that entry. Unknown fields are ignored (additions keep the version).
 */
export function parseSpaceManifest(
  plaintext: Uint8Array,
  expected: { spaceId: string; writer: ManifestWriter },
): SpaceManifest {
  if (plaintext.length < 1 || plaintext[0] !== MANIFEST_FORMAT_VERSION) {
    throw new ManifestFormatError('unknown-version');
  }
  let doc: unknown;
  try {
    doc = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(plaintext.subarray(1)),
    );
  } catch {
    throw new ManifestFormatError('invalid-json');
  }
  if (!isRecord(doc)) throw new ManifestFormatError('not-an-object');
  if (doc.spaceId !== expected.spaceId) {
    throw new ManifestFormatError('space-mismatch');
  }
  if (doc.writer !== expected.writer) {
    throw new ManifestFormatError('writer-mismatch');
  }
  if (!Array.isArray(doc.files)) throw new ManifestFormatError('no-files');
  if (doc.files.length > MANIFEST_MAX_FILES) {
    throw new ManifestFormatError('too-many-files');
  }
  const files: ManifestFile[] = [];
  const seen = new Set<string>();
  let skippedEntries = 0;
  for (const entry of doc.files as unknown[]) {
    const file = parseFile(entry);
    if (!file || seen.has(file.fileId)) {
      skippedEntries += 1;
      continue;
    }
    seen.add(file.fileId);
    files.push(file);
  }
  return { writer: expected.writer, files, skippedEntries };
}

/**
 * The plaintext of a manifest (`0x01 ‖ UTF-8 JSON`, docs/hubs/space-manifest.md) — what the server writes for the
 * cloud manifest. Legible: the caller encrypts it with the space key and wipes the bytes.
 */
export function serializeSpaceManifest(
  spaceId: string,
  writer: ManifestWriter,
  files: readonly ManifestFile[],
  updatedAt: Date,
): Uint8Array {
  const json = JSON.stringify({
    spaceId,
    writer,
    updatedAt: updatedAt.toISOString(),
    files: files.map((f) => ({
      fileId: f.fileId,
      name: f.name,
      path: f.path,
      mediaType: f.mediaType,
      source: f.source,
      modifiedAt: f.modifiedAt ? f.modifiedAt.toISOString() : null,
      parts: f.parts,
    })),
  });
  const body = new TextEncoder().encode(json);
  const out = new Uint8Array(1 + body.length);
  out[0] = MANIFEST_FORMAT_VERSION;
  out.set(body, 1);
  return out;
}
