export type SessionTokens = {
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
};
