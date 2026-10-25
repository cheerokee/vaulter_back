export interface AccessTokenClaims {
  userId: string;
  sessionId: string;
}

/** Port: issues and verifies short-lived signed access tokens. */
export abstract class AccessTokenService {
  abstract issue(
    claims: AccessTokenClaims,
    now: Date,
  ): Promise<{ token: string; expiresAt: Date }>;
  /** Any failure throws UnauthenticatedError('invalid-access-token'). */
  abstract verify(token: string, now: Date): Promise<AccessTokenClaims>;
}
