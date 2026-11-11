import { CHUNK_MAX_CHARS, CHUNK_MIN_CHARS } from './indexing-limits.js';

/**
 * Splits a file's text into the chunks that are embedded, the same way the Hub does
 * (`vaulter-hub-back/index_docs.py`, `chunk_text`): paragraphs (separated by a blank line) packed into chunks of up to
 * 800 characters joined by a blank line; a paragraph longer than that is cut in fixed 800-character pieces; no
 * overlap; chunks shorter than 80 characters are dropped. One difference: when the whole text is a single short chunk,
 * it is kept (a short note would otherwise not be searchable at all).
 */
export function chunkText(raw: string): string[] {
  const text = raw.replace(/\r\n?/g, '\n');
  const paragraphs = text
    .split(/\n[^\S\n]*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const pieces: string[] = [];
  for (const p of paragraphs) {
    if (p.length <= CHUNK_MAX_CHARS) {
      pieces.push(p);
    } else {
      for (let k = 0; k < p.length; k += CHUNK_MAX_CHARS) {
        pieces.push(p.slice(k, k + CHUNK_MAX_CHARS));
      }
    }
  }
  const chunks: string[] = [];
  let buffer = '';
  for (const p of pieces) {
    if (buffer.length + p.length + 2 <= CHUNK_MAX_CHARS) {
      buffer = buffer ? `${buffer}\n\n${p}` : p;
    } else {
      if (buffer.length >= CHUNK_MIN_CHARS) chunks.push(buffer);
      buffer = p;
    }
  }
  if (buffer.length >= CHUNK_MIN_CHARS) chunks.push(buffer);
  if (chunks.length === 0 && buffer.trim().length > 0) chunks.push(buffer);
  return chunks;
}
