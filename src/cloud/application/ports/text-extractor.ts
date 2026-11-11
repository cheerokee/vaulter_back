/**
 * What came out of a file: its text (possibly truncated at `EXTRACTED_TEXT_MAX_CHARS`), or why there is none. Reasons
 * are codes (they go to logs); the text is legible and never logged.
 */
export type ExtractionResult =
  | { kind: 'text'; text: string; truncated: boolean }
  | { kind: 'unsupported' }
  | { kind: 'unreadable'; reason: string };

/**
 * Text extraction by media type (spec active-cloud §4.2, formats v1): PDF, Word (docx), spreadsheets (xlsx, csv),
 * Markdown, plain text and HTML. Anything else: `unsupported`. Never throws for bad input (a corrupt file, a zip bomb,
 * a PDF that does not parse): `unreadable` with a reason code. Implementations never log the bytes or the text.
 */
export abstract class TextExtractor {
  abstract supports(mediaType: string): boolean;
  abstract extract(
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<ExtractionResult>;
}
