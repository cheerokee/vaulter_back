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
 * The AI budget seen from the indexing (spec active-cloud §4.4; Review Focus 3). Before EVERY embedding call the job
 * reserves the batch's estimated cost (`reserve`); `null` means the organization's budget for the month is exhausted:
 * the job stops at this batch without writing (the file stays `pending`) and the indexing of the space resumes when the
 * budget is raised or the month turns. After the call, `settle` records what the batch really used (also when the
 * answer turns out unusable: the call was made); a call that failed gets its reservation back (`release`). The job
 * logs only ids, counts and cost.
 */
export abstract class IndexingCostMeter {
  abstract reserve(
    scope: IndexingUsageScope,
    texts: readonly string[],
  ): Promise<IndexingCharge | null>;
  abstract settle(charge: IndexingCharge, usage: IndexingUsage): Promise<void>;
  abstract release(charge: IndexingCharge): Promise<void>;
}
