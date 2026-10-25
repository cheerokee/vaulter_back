import type { SessionTokens } from '../../../application/dto/session-tokens.js';

export class SessionTokensResponse {
  sessionId!: string;
  accessToken!: string;
  accessTokenExpiresAt!: string;
  refreshToken!: string;
  refreshTokenExpiresAt!: string;

  static from(tokens: SessionTokens): SessionTokensResponse {
    const res = new SessionTokensResponse();
    res.sessionId = tokens.sessionId;
    res.accessToken = tokens.accessToken;
    res.accessTokenExpiresAt = tokens.accessTokenExpiresAt.toISOString();
    res.refreshToken = tokens.refreshToken;
    res.refreshTokenExpiresAt = tokens.refreshTokenExpiresAt.toISOString();
    return res;
  }
}
