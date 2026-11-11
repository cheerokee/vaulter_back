// Text extraction of the active cloud, run in a worker thread (piscina) so parsing a big or hostile file never blocks
// the API's event loop, under a wall-clock limit and a heap cap set by the pool (`WorkerTextExtractor`).
// Self-contained on purpose: loaded from compiled .js in production and from .ts (Node strips types natively) under
// Vitest, so only erasable TypeScript (no enums, namespaces or parameter properties) and no relative imports; the
// limits come in every job. Never logs; every failure is a reason code.
import { unzipSync } from 'fflate';
import { Parser } from 'htmlparser2';
import { extractText, getDocumentProxy } from 'unpdf';

export const DOCX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MEDIA_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Formats v1 (spec active-cloud §4.2; docs/hubs/space-manifest.md "Formatos indexados"). */
export const SUPPORTED_MEDIA_TYPES: readonly string[] = [
  'application/pdf',
  DOCX_MEDIA_TYPE,
  XLSX_MEDIA_TYPE,
  'text/csv',
  'text/markdown',
  'text/plain',
  'text/html',
];

export interface ExtractionLimits {
  maxChars: number;
  zipMaxEntries: number;
  zipEntryMaxBytes: number;
  zipTotalMaxBytes: number;
  zipMaxRatio: number;
}

export interface ExtractionJob {
  mediaType: string;
  bytes: Uint8Array;
  limits: ExtractionLimits;
}

export type WorkerExtractionResult =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'unsupported' }
  | { kind: 'unreadable'; reason: string };

/** Accumulates text up to `max` characters; `paragraph()` ends the current paragraph (a blank line). */
export class TextSink {
  private readonly parts: string[] = [];
  private length = 0;
  private line = '';
  private readonly max: number;
  truncated = false;

  constructor(max: number) {
    this.max = max;
  }

  get full(): boolean {
    return this.length >= this.max;
  }

  write(text: string): void {
    if (this.full) {
      if (text.length > 0) this.truncated = true;
      return;
    }
    const room = this.max - this.length - this.line.length;
    if (text.length > room) {
      this.line += text.slice(0, Math.max(0, room));
      this.truncated = true;
      this.flush();
      this.length = this.max;
      return;
    }
    this.line += text;
  }

  paragraph(): void {
    this.flush();
  }

  private flush(): void {
    const p = this.line.replace(/[^\S\n]+/g, ' ').trim();
    this.line = '';
    if (p.length === 0) return;
    this.parts.push(p);
    this.length += p.length + 2;
  }

  text(): string {
    this.flush();
    return this.parts.join('\n\n');
  }
}

const decodeUtf8 = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8').decode(bytes);

function capped(text: string, max: number): WorkerExtractionResult {
  return text.length > max
    ? { kind: 'text', text: text.slice(0, max), truncated: true }
    : { kind: 'text', text, truncated: false };
}

/** Plain text and Markdown: the text as it is. */
function extractPlain(
  bytes: Uint8Array,
  l: ExtractionLimits,
): WorkerExtractionResult {
  return capped(decodeUtf8(bytes), l.maxChars);
}

/** CSV: one line per paragraph, so the chunker packs whole rows. */
function extractCsv(
  bytes: Uint8Array,
  l: ExtractionLimits,
): WorkerExtractionResult {
  const lines = decodeUtf8(bytes)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);
  return capped(lines.join('\n\n'), l.maxChars);
}

const HTML_SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
]);
const HTML_BLOCK = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'title',
  'tr',
  'ul',
]);

/** HTML (UTF-8): visible text, a paragraph per block element; table cells separated by a space. */
function extractHtml(
  bytes: Uint8Array,
  l: ExtractionLimits,
): WorkerExtractionResult {
  const sink = new TextSink(l.maxChars);
  let skipping = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (HTML_SKIP.has(name)) skipping += 1;
        else if (HTML_BLOCK.has(name)) sink.paragraph();
      },
      ontext(text) {
        if (skipping === 0) sink.write(text);
      },
      onclosetag(name) {
        if (HTML_SKIP.has(name)) skipping = Math.max(0, skipping - 1);
        else if (HTML_BLOCK.has(name)) sink.paragraph();
        else if (name === 'td' || name === 'th') sink.write(' ');
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(decodeUtf8(bytes));
  parser.end();
  return { kind: 'text', text: sink.text(), truncated: sink.truncated };
}

/** Why a zip (docx/xlsx) is not read. */
export class ZipRefusedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`zip refused: ${reason}`);
    this.name = 'ZipRefusedError';
    this.reason = reason;
  }
}

/**
 * Inflates ONLY the entries `wanted` accepts, after checking the central directory against the zip-bomb limits
 * (entries, uncompressed size per entry and in total, compression ratio) BEFORE inflating anything. fflate inflates
 * each entry into a buffer of its declared size, so an entry that lies about its size cannot grow past it (a stored
 * entry is never bigger than the file itself).
 */
export function readZipEntries(
  bytes: Uint8Array,
  wanted: (name: string) => boolean,
  l: ExtractionLimits,
): Map<string, Uint8Array> {
  let entries = 0;
  let total = 0;
  let refused: string | null = null;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        entries += 1;
        if (entries > l.zipMaxEntries) refused ??= 'too-many-entries';
        if (refused || !wanted(file.name)) return false;
        if (file.originalSize > l.zipEntryMaxBytes) {
          refused = 'entry-too-large';
          return false;
        }
        if (file.originalSize > Math.max(1, file.size) * l.zipMaxRatio) {
          refused = 'compression-ratio';
          return false;
        }
        total += file.originalSize;
        if (total > l.zipTotalMaxBytes) {
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

interface XmlHandlers {
  open?: (name: string, attrs: Record<string, string>) => void;
  text?: (text: string) => void;
  close?: (name: string) => void;
}

function parseXml(bytes: Uint8Array, handlers: XmlHandlers): void {
  const parser = new Parser(
    {
      onopentag: (name, attrs) => handlers.open?.(name, attrs),
      ontext: (text) => handlers.text?.(text),
      onclosetag: (name) => handlers.close?.(name),
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.write(decodeUtf8(bytes));
  parser.end();
}

/** Word (docx): the text of `word/document.xml`, one paragraph per `w:p` (tables included, cell by cell). */
function extractDocx(
  bytes: Uint8Array,
  l: ExtractionLimits,
): WorkerExtractionResult {
  const files = readZipEntries(bytes, (n) => n === 'word/document.xml', l);
  const doc = files.get('word/document.xml');
  if (!doc) return { kind: 'unreadable', reason: 'docx-without-document' };
  const sink = new TextSink(l.maxChars);
  let inText = false;
  parseXml(doc, {
    open(name) {
      if (name === 'w:t') inText = true;
      else if (name === 'w:tab' || name === 'w:br' || name === 'w:cr')
        sink.write(' ');
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
function extractXlsx(
  bytes: Uint8Array,
  l: ExtractionLimits,
): WorkerExtractionResult {
  const files = readZipEntries(
    bytes,
    (n) =>
      n === 'xl/workbook.xml' ||
      n === 'xl/_rels/workbook.xml.rels' ||
      n === 'xl/sharedStrings.xml' ||
      SHEET_PATH.test(n),
    l,
  );
  const workbook = files.get('xl/workbook.xml');
  if (!workbook) return { kind: 'unreadable', reason: 'xlsx-without-workbook' };
  const rels = new Map<string, string>();
  const relsXml = files.get('xl/_rels/workbook.xml.rels');
  if (relsXml) {
    parseXml(relsXml, {
      open(name, a) {
        if (name === 'Relationship' && a.Id && a.Target)
          rels.set(a.Id, sheetTarget(a.Target));
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
  const sink = new TextSink(l.maxChars);
  for (const sheet of sheets) {
    if (sink.full) {
      sink.truncated = true;
      break;
    }
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
        } else if (name === 'row' && row.length > 0) {
          sink.write(row.join(' '));
          sink.paragraph();
        }
      },
    });
  }
  return { kind: 'text', text: sink.text(), truncated: sink.truncated };
}

/**
 * PDF (pdf.js through unpdf): the text layer of every page, a paragraph per line, a blank line between pages. No OCR,
 * no font faces, no system fonts, and only errors from pdf.js (its warnings would go to the console).
 */
async function extractPdf(
  bytes: Uint8Array,
  l: ExtractionLimits,
): Promise<WorkerExtractionResult> {
  const pdf = await getDocumentProxy(bytes, {
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const sink = new TextSink(l.maxChars);
    for (const page of text) {
      if (sink.full) {
        sink.truncated = true;
        break;
      }
      for (const line of page.split('\n')) {
        sink.write(line);
        sink.paragraph();
      }
    }
    return { kind: 'text', text: sink.text(), truncated: sink.truncated };
  } finally {
    await pdf.loadingTask.destroy();
  }
}

type Extract = (
  bytes: Uint8Array,
  l: ExtractionLimits,
) => WorkerExtractionResult | Promise<WorkerExtractionResult>;

const EXTRACTORS: Record<string, Extract> = {
  'application/pdf': extractPdf,
  [DOCX_MEDIA_TYPE]: extractDocx,
  [XLSX_MEDIA_TYPE]: extractXlsx,
  'text/csv': extractCsv,
  'text/markdown': extractPlain,
  'text/plain': extractPlain,
  'text/html': extractHtml,
};

/** Never throws for bad input: `unreadable` with a code. The input buffer is wiped when done. */
export async function extract(
  job: ExtractionJob,
): Promise<WorkerExtractionResult> {
  const { mediaType, bytes, limits } = job;
  try {
    const fn = Object.hasOwn(EXTRACTORS, mediaType)
      ? EXTRACTORS[mediaType]
      : undefined;
    if (!fn) return { kind: 'unsupported' };
    // pdf.js takes ownership of what it parses: it gets a copy, the original is wiped below.
    return await fn(
      mediaType === 'application/pdf' ? new Uint8Array(bytes) : bytes,
      limits,
    );
  } catch (error) {
    if (error instanceof ZipRefusedError) {
      return { kind: 'unreadable', reason: `zip-${error.reason}` };
    }
    return { kind: 'unreadable', reason: 'parse-failed' };
  } finally {
    bytes.fill(0);
  }
}

export default extract;
