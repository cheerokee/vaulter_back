import { chunkText } from './text-chunker.js';

describe('chunkText (the Hub algorithm)', () => {
  const para = (n: number, c = 'a') => c.repeat(n);

  it('packs paragraphs up to 800 chars joined by a blank line', () => {
    const chunks = chunkText(
      [para(300), para(300, 'b'), para(300, 'c')].join('\n\n'),
    );
    expect(chunks).toEqual([
      `${para(300)}\n\n${para(300, 'b')}`,
      para(300, 'c'),
    ]);
  });

  it('cuts a paragraph longer than 800 chars in fixed pieces', () => {
    const chunks = chunkText(para(2000));
    expect(chunks.map((c) => c.length)).toEqual([800, 800, 400]);
  });

  it('drops pieces under 80 chars, but keeps a short text that is all the file has', () => {
    expect(chunkText(`${para(795)}\n\nshort`)).toEqual([para(795)]);
    expect(chunkText('a short note')).toEqual(['a short note']);
    expect(chunkText('  \n\n  ')).toEqual([]);
  });

  it('normalizes CRLF and blank lines with spaces', () => {
    expect(chunkText(`${para(100)}\r\n \r\n${para(100, 'b')}`)).toEqual([
      `${para(100)}\n\n${para(100, 'b')}`,
    ]);
  });
});
