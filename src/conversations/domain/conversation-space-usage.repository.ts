/**
 * The conversations part of a space usage: message bodies still stored and the part of them with a tombstone; committed
 * attachments (until purged) plus live upload reservations, and the committed ones with a tombstone.
 */
export type ConversationSpaceUsageTotals = {
  bodyBytes: number;
  trashBytes: number;
  attachmentBytes: number;
  attachmentTrashBytes: number;
};

/**
 * Reads what the database keeps per space by trigger (the counter of `conversation_messages` and the projection of
 * `conversation_attachments`): every conversation of the space, whoever reads it (organization scope only; messages
 * and attachments themselves are visible only to participants).
 */
export abstract class ConversationSpaceUsageRepository {
  abstract totals(
    organizationId: string,
    spaceId: string,
  ): Promise<ConversationSpaceUsageTotals>;
}
