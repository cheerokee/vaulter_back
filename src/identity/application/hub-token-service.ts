/**
 * Short-lived access token of an authenticated Hub (exported for the `hubs` module). Same signing keys, `kid`
 * rotation, issuer and audience as the user access tokens, but a distinct `typ` (`hub+jwt`): a hub token never
 * passes the user guard and a user token never passes `verify`. The hubs guard still checks, on every request,
 * that the hub exists and is not deregistered.
 */
export abstract class HubTokenService {
  /** Signs a token for `hubId` (`sub`), valid for 15 minutes. */
  abstract issue(
    hubId: string,
    now?: Date,
  ): Promise<{ token: string; expiresAt: Date }>;
  /** Any failure (signature, kid, typ, iss, aud, expiry, claims) throws UnauthenticatedError('invalid-hub-token'). */
  abstract verify(token: string, now?: Date): Promise<{ hubId: string }>;
}
