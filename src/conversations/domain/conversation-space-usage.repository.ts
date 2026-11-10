/** The conversations part of a space usage: message bodies still stored, and the part of them with a tombstone. */
export type ConversationSpaceUsageTotals = {
  bodyBytes: number;
  trashBytes: number;
};

/**
 * Reads the per-space counter kept by the database (trigger on `conversation_messages`): every conversation of the
 * space, whoever reads it (organization scope only; the messages themselves are visible only to participants).
 */
export abstract class ConversationSpaceUsageRepository {
  abstract totals(
    organizationId: string,
    spaceId: string,
  ): Promise<ConversationSpaceUsageTotals>;
}
