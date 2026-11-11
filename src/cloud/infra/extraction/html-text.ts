import { Parser } from 'htmlparser2';
import type { ExtractionResult } from '../../application/ports/text-extractor.js';
import { decodeUtf8 } from './plain-text.js';
import { TextSink } from './text-sink.js';

/** Content never shown as text. */
const SKIP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'iframe',
  'object',
]);
/** Elements that end a paragraph. */
const BLOCK = new Set([
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
export function extractHtml(bytes: Uint8Array): ExtractionResult {
  const sink = new TextSink();
  let skipping = 0;
  const parser = new Parser(
    {
      onopentag(name) {
        if (SKIP.has(name)) skipping += 1;
        else if (BLOCK.has(name)) sink.paragraph();
      },
      ontext(text) {
        if (skipping === 0) sink.write(text);
      },
      onclosetag(name) {
        if (SKIP.has(name)) skipping = Math.max(0, skipping - 1);
        else if (BLOCK.has(name)) sink.paragraph();
        else if (name === 'td' || name === 'th') sink.write('\t');
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.write(decodeUtf8(bytes));
  parser.end();
  return { kind: 'text', text: sink.text(), truncated: sink.truncated };
}
