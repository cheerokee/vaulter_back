/** Who acts on a conversation: a person (user token) or a Hub (hub token). */
export type ConversationActor =
  { kind: 'user'; userId: string } | { kind: 'hub'; hubId: string };

/**
 * Row-level security scope of every repository call: the organization and exactly one principal. Rows are visible only
 * when the person is a live participant of the conversation or the Hub is its executor (migration CreateConversations).
 */
export type ConversationScope = {
  organizationId: string;
  actor: ConversationActor;
};

export function sameActor(a: ConversationActor, b: ConversationActor): boolean {
  return a.kind === 'user'
    ? b.kind === 'user' && a.userId === b.userId
    : b.kind === 'hub' && a.hubId === b.hubId;
}
