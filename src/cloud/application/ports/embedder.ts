export type EmbeddingKind = 'document' | 'query';

export interface EmbeddingResult {
  /** One vector per input text, same order. All have `dimensions` entries. */
  vectors: number[][];
  /** Model that produced them; recorded in every indexed chunk (spec active-cloud §3). */
  model: string;
  dimensions: number;
  /** Tokens the service counted in the inputs (an estimate when the service does not report it). For `AiPricing`. */
  inputTokens: number;
}

/**
 * Text embeddings for the active cloud (same model as the Hub: `nomic-embed-text`, 768 dimensions).
 *
 * `kind` says whether a text is a chunk to index or a search query. TODAY BOTH KINDS GET THE SAME TREATMENT: the Hub
 * (`vaulter-hub-back/index_docs.py`) embeds with no task prefix, so vectors from the cloud and from the Hub are
 * comparable only while we do the same. Adding the `search_document: ` / `search_query: ` prefixes nomic recommends is
 * a joint change with the Hub and needs a full reindex on both sides; this port is the single place to do it.
 *
 * Implementations never log the texts.
 */
export abstract class Embedder {
  abstract embed(
    texts: readonly string[],
    kind: EmbeddingKind,
  ): Promise<EmbeddingResult>;
}
