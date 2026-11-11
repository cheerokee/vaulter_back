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

/** A reservation taken for one embedding batch (opaque to the job). */
export type IndexingCharge = { readonly reservationId: string };

/**
 * The AI budget seen from the indexing (spec active-cloud §4.4; Review Focus 3). Before the FIRST embedding call of a
 * file the job reserves the estimated cost of the whole file (`reserve` with every chunk); `null` means what is left of
 * the organization's month does not cover it: the file does not start (nothing embedded, nothing paid, the file stays
 * `pending`) and the indexing of the space resumes when the budget is raised or the month turns. So a pause never
 * throws away a paid batch, and a big indexing (many files) stops at its next file. Between batches the job renews the
 * reservation (`keepAlive`, so a long file never outlives its reservation); at the end `settle` records what the calls
 * made really used (also when the job failed in the middle: the calls were made), or `release` when none was made.
 * The job logs only ids, counts and cost.
 */
export abstract class IndexingCostMeter {
  abstract reserve(
    scope: IndexingUsageScope,
    texts: readonly string[],
  ): Promise<IndexingCharge | null>;
  abstract keepAlive(charge: IndexingCharge): Promise<void>;
  abstract settle(charge: IndexingCharge, usage: IndexingUsage): Promise<void>;
  abstract release(charge: IndexingCharge): Promise<void>;
}
