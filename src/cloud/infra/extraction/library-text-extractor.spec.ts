import { strToU8, zipSync } from 'fflate';
import {
  docxBytes,
  pdfBytes,
  xlsxBytes,
} from '../../testing/document-fixtures.js';
import { EXTRACTORS, LibraryTextExtractor } from './library-text-extractor.js';
import { readZipEntries } from './office-text.js';

const DOCX =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const enc = (s: string) => new TextEncoder().encode(s);

describe('LibraryTextExtractor', () => {
  const x = new LibraryTextExtractor();

  it('supports exactly the v1 formats', () => {
    expect(Object.keys(EXTRACTORS).sort()).toEqual(
      [
        'application/pdf',
        DOCX,
        XLSX,
        'text/csv',
        'text/html',
        'text/markdown',
        'text/plain',
      ].sort(),
    );
    expect(x.supports('image/png')).toBe(false);
  });

  it('plain text and markdown: as they are (UTF-8)', async () => {
    expect(await x.extract('text/markdown', enc('# Título\n\nAção'))).toEqual({
      kind: 'text',
      text: '# Título\n\nAção',
      truncated: false,
    });
  });

  it('csv: one paragraph per row', async () => {
    const r = await x.extract('text/csv', enc('a,b\r\nc,d\n\n'));
    expect(r).toEqual({ kind: 'text', text: 'a,b\n\nc,d', truncated: false });
  });

  it('html: visible text, blocks as paragraphs, no scripts or styles, entities decoded', async () => {
    const r = await x.extract(
      'text/html',
      enc(
        '<html><head><title>T</title><style>.x{}</style><script>alert(1)</script></head><body><h1>Olá &amp; bem</h1><p>um <b>dois</b></p><table><tr><td>a</td><td>b</td></tr></table></body></html>',
      ),
    );
    expect(r).toEqual({
      kind: 'text',
      text: 'T\n\nOlá & bem\n\num dois\n\na b',
      truncated: false,
    });
  });

  it('docx: one paragraph per w:p', async () => {
    const r = await x.extract(
      DOCX,
      docxBytes(['Primeiro parágrafo', 'Segundo & último']),
    );
    expect(r).toEqual({
      kind: 'text',
      text: 'Primeiro parágrafo\n\nSegundo & último',
      truncated: false,
    });
  });

  it('xlsx: sheets in workbook order, name first, one paragraph per row', async () => {
    const r = await x.extract(
      XLSX,
      xlsxBytes([
        {
          name: 'Preços',
          rows: [
            ['Brita 1', '120'],
            ['Areia', '90'],
          ],
        },
        { name: 'Notas', rows: [['ok']] },
      ]),
    );
    expect(r).toEqual({
      kind: 'text',
      text: 'Preços\n\nBrita 1 120\n\nAreia 90\n\nNotas\n\nok',
      truncated: false,
    });
  });

  it('pdf: the text layer, line by line', async () => {
    const r = await x.extract(
      'application/pdf',
      pdfBytes(['Relatorio da pedreira', 'segunda linha']),
    );
    expect(r).toEqual({
      kind: 'text',
      text: 'Relatorio da pedreira\n\nsegunda linha',
      truncated: false,
    });
  });

  it('bad input never throws: unreadable with a code; unknown type: unsupported', async () => {
    expect(await x.extract('application/pdf', enc('not a pdf'))).toEqual({
      kind: 'unreadable',
      reason: 'parse-failed',
    });
    expect(await x.extract(DOCX, enc('not a zip'))).toEqual({
      kind: 'unreadable',
      reason: 'zip-corrupt',
    });
    expect(await x.extract('image/png', enc('x'))).toEqual({
      kind: 'unsupported',
    });
  });

  it('zip bombs are refused before inflating: compression ratio and entry size', async () => {
    const bomb = zipSync({
      'word/document.xml': new Uint8Array(10 * 1024 * 1024),
    });
    expect(await x.extract(DOCX, bomb)).toEqual({
      kind: 'unreadable',
      reason: 'zip-compression-ratio',
    });
    // Entries we do not read are never inflated (a huge image inside a docx costs nothing).
    const withMedia = zipSync({
      'word/document.xml': strToU8(
        '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>',
      ),
      'word/media/big.bin': new Uint8Array(10 * 1024 * 1024),
    });
    expect(await x.extract(DOCX, withMedia)).toMatchObject({ text: 'ok' });
  });

  it('a deflated entry that lies about its size cannot grow past what it declared', () => {
    // (A stored entry is never bigger than the file itself, which is capped.)
    const real = strToU8('x'.repeat(5000));
    const zip = zipSync({ 'word/document.xml': [real, { level: 6 }] });
    // Patch the declared uncompressed size (local header and central directory) to 10 bytes.
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    view.setUint32(22, 10, true);
    const cd = zip.length - 22 - 46 - 'word/document.xml'.length;
    view.setUint32(cd + 24, 10, true);
    let out: Map<string, Uint8Array> | undefined;
    try {
      out = readZipEntries(zip, () => true);
    } catch {
      out = undefined; // refused as corrupt: fine too
    }
    if (out)
      expect(out.get('word/document.xml')!.length).toBeLessThanOrEqual(10);
  });
});
