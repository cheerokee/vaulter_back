/**
 * The authenticated caller: the user and the device session of the access token. `hubId`: the Hub the session is
 * bound to (opened through `POST /hub/user-sessions`), read from the session row, never from the request; null or
 * absent for an ordinary device session.
 */
export type Actor = {
  userId: string;
  sessionId: string;
  hubId?: string | null;
};
