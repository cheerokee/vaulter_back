import {
  ManifestFormatError,
  normalizeMediaType,
  parseSpaceManifest,
} from './space-manifest.js';

const SPACE = '0195f3a2-7c4e-7b1d-9a3f-2c8e5d4b6a10';
const F1 = '0195f3a2-7c4e-7b1d-9a3f-000000000001';
const F2 = '0195f3a2-7c4e-7b1d-9a3f-000000000002';
const P1 = '0195f3a2-7c4e-7b1d-9a3f-0000000000a1';
const P2 = '0195f3a2-7c4e-7b1d-9a3f-0000000000a2';

const bytes = (doc: unknown, version = 1) =>
  new Uint8Array([version, ...new TextEncoder().encode(JSON.stringify(doc))]);
const file = (over: Record<string, unknown> = {}) => ({
  fileId: F1,
  name: 'Relatório.pdf',
  path: 'Clientes/Orion',
  mediaType: 'application/pdf',
  source: { kind: 'file' },
  modifiedAt: '2026-11-10T12:00:00.000Z',
  sizeBytes: 1234,
  parts: [P1, P2],
  ...over,
});
const manifest = (files: unknown[], over: Record<string, unknown> = {}) => ({
  spaceId: SPACE,
  writer: 'hub',
  updatedAt: '2026-11-10T12:00:00Z',
  files,
  ...over,
});
const parse = (b: Uint8Array, writer: 'hub' | 'cloud' = 'hub') =>
  parseSpaceManifest(b, { spaceId: SPACE, writer });

describe('parseSpaceManifest', () => {
  it('parses the documented format (unknown fields ignored)', () => {
    const m = parse(bytes(manifest([file({ extra: true })], { future: 1 })));
    expect(m).toEqual({
      writer: 'hub',
      skippedEntries: 0,
      files: [
        {
          fileId: F1,
          name: 'Relatório.pdf',
          path: 'Clientes/Orion',
          mediaType: 'application/pdf',
          source: { kind: 'file' },
          modifiedAt: new Date('2026-11-10T12:00:00.000Z'),
          parts: [P1, P2],
        },
      ],
    });
  });

  it.each([
    ['unknown version byte', bytes(manifest([]), 2), 'unknown-version'],
    ['empty', new Uint8Array(), 'unknown-version'],
    ['not JSON', new Uint8Array([1, 0x7b]), 'invalid-json'],
    ['not an object', bytes([]), 'not-an-object'],
    ['another space', bytes(manifest([], { spaceId: F1 })), 'space-mismatch'],
    [
      'another writer',
      bytes(manifest([], { writer: 'cloud' })),
      'writer-mismatch',
    ],
    ['no files', bytes(manifest([], { files: undefined })), 'no-files'],
  ])('%s: the whole manifest is refused', (_, b, reason) => {
    expect(() => parse(b)).toThrow(ManifestFormatError);
    expect(() => parse(b)).toThrow(reason);
  });

  it('a bad entry or a repeated fileId drops only that entry', () => {
    const m = parse(
      bytes(
        manifest([
          file(),
          file({ name: 'repeated' }),
          file({ fileId: F2, parts: [] }),
          file({ fileId: F2, parts: [P1, P1] }),
          file({ fileId: F2, mediaType: 'not a type' }),
          file({ fileId: F2, source: { kind: 'connector' } }),
          file({ fileId: F2, modifiedAt: '10/11/2026' }),
          file({ fileId: 'not-a-uuid' }),
          file({ fileId: F2, parts: ['0f8dd96c-0864-54ce-a76d-83887a207df4'] }),
        ]),
      ),
    );
    expect(m.files.map((f) => f.fileId)).toEqual([F1]);
    expect(m.files[0]!.name).toBe('Relatório.pdf');
    expect(m.skippedEntries).toBe(8);
  });

  it('connector sources, optional path/modifiedAt and media type parameters', () => {
    const m = parse(
      bytes(
        manifest(
          [
            file({
              fileId: F2,
              path: undefined,
              modifiedAt: null,
              mediaType: 'Text/Plain; charset=UTF-8',
              source: { kind: 'connector', connector: 'google-drive' },
            }),
          ],
          { writer: 'cloud' },
        ),
      ),
      'cloud',
    );
    expect(m.files[0]).toMatchObject({
      path: null,
      modifiedAt: null,
      mediaType: 'text/plain',
      source: { kind: 'connector', connector: 'google-drive' },
    });
  });

  it('normalizeMediaType', () => {
    expect(normalizeMediaType(' TEXT/HTML ; charset=utf-8')).toBe('text/html');
    expect(normalizeMediaType('text')).toBeNull();
  });
});
