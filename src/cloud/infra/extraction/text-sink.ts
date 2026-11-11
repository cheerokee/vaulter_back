import { EXTRACTED_TEXT_MAX_CHARS } from '../../domain/indexing-limits.js';

/**
 * Accumulates extracted text up to `EXTRACTED_TEXT_MAX_CHARS` (the rest is dropped and `truncated` is set), so a
 * huge document never builds an unbounded string. `paragraph()` ends the current paragraph (a blank line).
 */
export class TextSink {
  private readonly parts: string[] = [];
  private length = 0;
  private line = '';
  truncated = false;

  constructor(private readonly max = EXTRACTED_TEXT_MAX_CHARS) {}

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
