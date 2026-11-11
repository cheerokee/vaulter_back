/** Whose embeddings these are. */
export type IndexingUsageScope = {
  organizationId: string;
  spaceId: string;
  /** The `cloud_files` row being indexed. */
  cloudFileId: string;
};

export type IndexingUsage = {
  model: string;
  inputTokens: number;
  /** `AiPricing.costMicroUsd` of this batch (micro-USD, rounded up). */
  costMicroUsd: bigint;
};

/**
 * The seam the AI budget (Task 5) hooks into: the indexing job calls `beforeBatch` before EVERY embedding call (a
 * budget that ran out throws there, so a big indexing stops at the next batch) and `record` after it with what the
 * batch used. The default (`NoopIndexingCostMeter`) only lets everything through; the job logs the totals (counts and
 * cost, never content).
 */
export abstract class IndexingCostMeter {
  abstract beforeBatch(scope: IndexingUsageScope, texts: number): Promise<void>;
  abstract record(
    scope: IndexingUsageScope,
    usage: IndexingUsage,
  ): Promise<void>;
}

export class NoopIndexingCostMeter extends IndexingCostMeter {
  async beforeBatch(): Promise<void> {}
  async record(): Promise<void> {}
}
