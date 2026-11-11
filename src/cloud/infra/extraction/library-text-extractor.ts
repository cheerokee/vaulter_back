import { Injectable } from '@nestjs/common';
import {
  TextExtractor,
  type ExtractionResult,
} from '../../application/ports/text-extractor.js';
import { extractHtml } from './html-text.js';
import { extractDocx, extractXlsx, ZipRefusedError } from './office-text.js';
import { extractPdf } from './pdf-text.js';
import { extractCsv, extractPlain } from './plain-text.js';

type Extract = (
  bytes: Uint8Array,
) => ExtractionResult | Promise<ExtractionResult>;

/** Formats v1 (spec active-cloud §4.2) by media type (docs/hubs/space-manifest.md, "Formatos indexados"). */
export const EXTRACTORS: Readonly<Record<string, Extract>> = {
  'application/pdf': extractPdf,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    extractDocx,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
    extractXlsx,
  'text/csv': extractCsv,
  'text/markdown': extractPlain,
  'text/plain': extractPlain,
  'text/html': extractHtml,
};

// Extração de texto com bibliotecas JS puras, versões fixadas (unpdf/pdf.js, fflate + htmlparser2 para docx/xlsx,
// htmlparser2 para HTML). Entrada ruim nunca derruba o job: vira `unreadable` com um código (zip recusado, PDF que
// não abre). Nada do conteúdo vai para log ou erro.
@Injectable()
export class LibraryTextExtractor extends TextExtractor {
  supports(mediaType: string): boolean {
    return Object.hasOwn(EXTRACTORS, mediaType);
  }

  async extract(
    mediaType: string,
    bytes: Uint8Array,
  ): Promise<ExtractionResult> {
    if (!this.supports(mediaType)) return { kind: 'unsupported' };
    try {
      return await EXTRACTORS[mediaType]!(bytes);
    } catch (error) {
      if (error instanceof ZipRefusedError) {
        return { kind: 'unreadable', reason: `zip-${error.reason}` };
      }
      return { kind: 'unreadable', reason: 'parse-failed' };
    }
  }
}
