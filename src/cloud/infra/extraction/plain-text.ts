import { EXTRACTED_TEXT_MAX_CHARS } from '../../domain/indexing-limits.js';
import type { ExtractionResult } from '../../application/ports/text-extractor.js';

/** UTF-8 (the contract's encoding for text formats); invalid bytes become U+FFFD, a BOM is dropped. */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

export function truncated(text: string): ExtractionResult {
  return text.length > EXTRACTED_TEXT_MAX_CHARS
    ? {
        kind: 'text',
        text: text.slice(0, EXTRACTED_TEXT_MAX_CHARS),
        truncated: true,
      }
    : { kind: 'text', text, truncated: false };
}

/** Plain text and Markdown: the text as it is (Markdown syntax is good text for embeddings). */
export function extractPlain(bytes: Uint8Array): ExtractionResult {
  return truncated(decodeUtf8(bytes));
}

/** CSV: one line per paragraph, so the chunker packs whole rows instead of cutting a long block every 800 chars. */
export function extractCsv(bytes: Uint8Array): ExtractionResult {
  const lines = decodeUtf8(bytes)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return truncated(lines.join('\n\n'));
}
