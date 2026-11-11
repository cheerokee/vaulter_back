import { extractText, getDocumentProxy } from 'unpdf';
import type { ExtractionResult } from '../../application/ports/text-extractor.js';
import { TextSink } from './text-sink.js';

/**
 * PDF (pdf.js through unpdf, pure JS): the text layer of every page, a paragraph per line break left by pdf.js, a
 * blank line between pages. No OCR (scanned pages give no text: spec active-cloud §2, out of scope). No font faces,
 * no system fonts, and only errors from pdf.js (its warnings would go to the console). pdf.js takes
 * ownership of the buffer it parses, so it gets a copy (the caller still wipes its own).
 */
export async function extractPdf(bytes: Uint8Array): Promise<ExtractionResult> {
  const pdf = await getDocumentProxy(new Uint8Array(bytes), {
    verbosity: 0,
    disableFontFace: true,
    useSystemFonts: false,
  });
  try {
    const { text } = await extractText(pdf, { mergePages: false });
    const sink = new TextSink();
    for (const page of text) {
      if (sink.full) {
        sink.write(page);
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
