import { unzipSync } from 'fflate';
import { Parser } from 'htmlparser2';
import type { ExtractionResult } from '../../application/ports/text-extractor.js';
import {
  ZIP_ENTRY_MAX_BYTES,
  ZIP_MAX_ENTRIES,
  ZIP_MAX_RATIO,
  ZIP_TOTAL_MAX_BYTES,
} from '../../domain/indexing-limits.js';
import { TextSink } from './text-sink.js';

/** Why a zip (docx/xlsx) is not read. */
export class ZipRefusedError extends Error {
  constructor(readonly reason: string) {
    super(`zip refused: ${reason}`);
    this.name = 'ZipRefusedError';
  }
}

/**
 * Inflates ONLY the entries `wanted` accepts, after checking the central directory against the zip-bomb limits
 * (entries, uncompressed size per entry and in total, compression ratio) BEFORE inflating anything. fflate inflates
 * each entry into a buffer of its declared size, so an entry that lies about its size cannot grow past it.
 */
export function readZipEntries(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
): Map<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  let refused: string | null = null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        entries += 1;
        if (entries > ZIP_MAX_ENTRIES) refused ??= 'too-many-entries';
        if (refused || !wanted(file.name)) return false;
        if (file.originalSize > ZIP_ENTRY_MAX_BYTES) {
          refused = 'entry-too-large';
          return false;
        }
        if (file.originalSize > Math.max(1, file.size) * ZIP_MAX_RATIO) {
          refused = 'compression-ratio';
          return false;
        }
        total += file.originalSize;
        if (total > ZIP_TOTAL_MAX_BYTES) {
          refused = 'total-too-large';
          return false;
        }
        return true;
      },
    });
  } catch {
    throw new ZipRefusedError('corrupt');
  }
  if (refused) throw new ZipRefusedError(refused);
  return new Map(Object.entries(files));
}

type XmlHandlers = {
  open?: (name: string, attrs: Record<string, string>) => void;
  text?: (text: string) => void;
  close?: (name: string) => void;
};

function parseXml(bytes: Uint8Array, handlers: XmlHandlers): void {
  const parser = new Parser(
    {
      onopentag: (name, attrs) => handlers.open?.(name, attrs),
      ontext: (text) => handlers.text?.(text),
      onclosetag: (name) => handlers.close?.(name),
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(new TextDecoder('utf-8').decode(bytes));
  parser.end();
}

/** Word (docx): the text of `word/document.xml`, one paragraph per `w:p` (tables included, cell by cell). */
export function extractDocx(bytes: Uint8Array): ExtractionResult {
  const files = readZipEntries(bytes, (n) => n === 'word/document.xml');
  const doc = files.get('word/document.xml');
  if (!doc) return { kind: 'unreadable', reason: 'docx-without-document' };
  const sink = new TextSink();
  let inText = false;
  parseXml(doc, {
    open(name) {
      if (name === 'w:t') inText = true;
      else if (name === 'w:tab') sink.write(' ');
      else if (name === 'w:br' || name === 'w:cr') sink.write(' ');
    },
    text(t) {
      if (inText) sink.write(t);
    },
    close(name) {
      if (name === 'w:t') inText = false;
      else if (name === 'w:p') sink.paragraph();
    },
  });
  return { kind: 'text', text: sink.text(), truncated: sink.truncated };
}

const SHEET_PATH = /^xl\/worksheets\/[^/]+\.xml$/;

function sheetTarget(target: string): string {
  return target.startsWith('/')
    ? target.slice(1)
    : `xl/${target.replace(/^\.\//, '')}`;
}

/**
 * Excel (xlsx): every sheet in workbook order, its name first, then one paragraph per row with the cell values
 * separated by a space (shared strings, inline strings, numbers and formula results as stored; no formatting).
 */
export function extractXlsx(bytes: Uint8Array): ExtractionResult {
  const files = readZipEntries(
    bytes,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      SHEET_PATH.test(n),
  );
  const workbook = files.get('xl/workbook.xml');
  if (!workbook) return { kind: 'unreadable', reason: 'xlsx-without-workbook' };

  const rels = new Map<string, string>();
  const relsXml = files.get('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    parseXml(relsXml, {
      open(name, a) {
        if (name === 'Relationship' && a.Id && a.Target) {
          rels.set(a.Id, sheetTarget(a.Target));
        }
      },
    });
  }
  const sheets: { name: string; path: string }[] = [];
  parseXml(workbook, {
    open(name, a) {
      if (name !== 'sheet') return;
      const path = a['r:id'] ? rels.get(a['r:id']) : undefined;
      if (path && files.has(path)) sheets.push({ name: a.name ?? '', path });
    },
  });

  const shared: string[] = [];
  const sharedXml = files.get('xl/sharedStrings.xml');
  if (sharedXml) {
    let current: string | null = null;
    let inText = false;
    parseXml(sharedXml, {
      open(name) {
        if (name === 'si') current = '';
        else if (name === 't') inText = true;
      },
      text(t) {
        if (inText && current !== null) current += t;
      },
      close(name) {
        if (name === 't') inText = false;
        else if (name === 'si') {
          shared.push(current ?? '');
          current = null;
        }
      },
    });
  }

  const sink = new TextSink();
  for (const sheet of sheets) {
    if (sink.full) break;
    sink.paragraph();
    if (sheet.name) {
      sink.write(sheet.name);
      sink.paragraph();
    }
    let cellType = '';
    let value = '';
    let inValue = false;
    let row: string[] = [];
    parseXml(files.get(sheet.path)!, {
      open(name, a) {
        if (name === 'row') row = [];
        else if (name === 'c') {
          cellType = a.t ?? 'n';
          value = '';
        } else if (name === 'v' || (name === 't' && cellType === 'inlineStr')) {
          inValue = true;
        }
      },
      text(t) {
        if (inValue) value += t;
      },
      close(name) {
        if (name === 'v' || name === 't') inValue = false;
        else if (name === 'c') {
          const cell = cellType === 's' ? (shared[Number(value)] ?? '') : value;
          if (cell.trim().length > 0) row.push(cell.trim());
        } else if (name === 'row') {
          if (row.length > 0) {
            sink.write(row.join(' '));
            sink.paragraph();
          }
        }
      },
    });
  }
  return { kind: 'text', text: sink.text(), truncated: sink.truncated };
}
