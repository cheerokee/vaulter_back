/**
 * Who acts on a conversation: a person (user token), a Hub (hub token) or the cloud as the reserve executor of the
 * conversations of ONE space (spec active-cloud §4.3; only the backend's own jobs, never a route). As a key recipient,
 * the cloud is the server key (`server_recipient`).
 */
export type ConversationActor =
  | { kind: 'user'; userId: string }
  | { kind: 'hub'; hubId: string }
  | { kind: 'cloud'; spaceId: string };

/**
 * Row-level security scope of every repository call: the organization and exactly one principal. Rows are visible only
 * when the person is a live participant of the conversation or the Hub is its executor (migration CreateConversations),
 * or, for the cloud, the conversation is live, of that space and has the cloud reserve (ConversationCloudReserve).
 */
export type ConversationScope = {
  organizationId: string;
  actor: ConversationActor;
  /**
   * A person whose session is bound to a Hub (opened through it): only the conversations that Hub executes are
   * reachable ("private is private": a Hub, even someone else's, never reaches the person's other conversations).
   */
  sessionHubId?: string | null;
};

/** Who calls a user route: the person and, when the session was opened through a Hub, that Hub. */
export type UserPrincipal = { userId: string; hubId?: string | null };

/** An actor without the scope detail: a message author, an ack, a key recipient (`cloud` = the server key). */
export type ActorRef =
  | { kind: 'user'; userId: string }
  | { kind: 'hub'; hubId: string }
  | { kind: 'cloud' };

export function sameActor(a: ActorRef, b: ActorRef): boolean {
  switch (a.kind) {
    case 'user':
      return b.kind === 'user' && a.userId === b.userId;
    case 'hub':
      return b.kind === 'hub' && a.hubId === b.hubId;
    case 'cloud':
      return b.kind === 'cloud';
  }
}
