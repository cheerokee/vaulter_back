/** Port: builds and parses opaque refresh tokens `<sessionId>.<secret>`. */
export abstract class RefreshTokenCodec {
  abstract generate(
    sessionId: string,
  ): Promise<{ token: string; hash: string }>;
  /** null when malformed or the id is not a UUID. */
  abstract parse(token: string): { sessionId: string; hash: string } | null;
}
