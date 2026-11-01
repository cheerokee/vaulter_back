import type { ConfigService } from '@nestjs/config';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import { newId } from '../../../shared/domain/id.js';
import { JoseAccessTokenService } from './jose-access-token-service.js';
import { JoseHubTokenService } from './jose-hub-token-service.js';

const SEED_A = 'A'.repeat(42) + 'A';
const SEED_B = 'B'.repeat(42) + 'A';
const config = (
  seed: string,
  extra: Record<string, unknown> = {},
  keyId = 'key-1',
  over: Record<string, unknown> = {},
) =>
  ({
    getOrThrow: (k: string) =>
      ({
        AUTH_JWT_ISSUER: 'test-issuer',
        AUTH_JWT_AUDIENCE: 'test-audience',
        AUTH_JWT_KEY_ID: keyId,
        AUTH_JWT_SIGNING_SEED: seed,
        AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
        ...over,
      })[k],
    get: (k: string) => extra[k],
  }) as unknown as ConfigService;

const INVALID = {
  constructor: UnauthenticatedError,
  code: 'invalid-hub-token',
};

describe('JoseHubTokenService', () => {
  const svc = new JoseHubTokenService(config(SEED_A));
  const users = new JoseAccessTokenService(config(SEED_A));
  beforeAll(async () => {
    await svc.onModuleInit();
    await users.onModuleInit();
  });
  const now = new Date('2026-11-01T12:00:00Z');
  const hubId = newId();

  it('round-trips the hub id; valid for 15 minutes', async () => {
    const { token, expiresAt } = await svc.issue(hubId, now);
    expect(expiresAt).toEqual(new Date(now.getTime() + 900_000));
    await expect(svc.verify(token, now)).resolves.toEqual({ hubId });
    await expect(
      svc.verify(token, new Date(now.getTime() + 901_000)),
    ).rejects.toMatchObject(INVALID);
  });

  it('is an EdDSA JWT with typ hub+jwt, the current kid, sub = hubId and the same iss/aud as user tokens', async () => {
    const { token } = await svc.issue(hubId, now);
    expect(decodeProtectedHeader(token)).toEqual({
      alg: 'EdDSA',
      kid: 'key-1',
      typ: 'hub+jwt',
    });
    expect(decodeJwt(token)).toEqual({
      iss: 'test-issuer',
      aud: 'test-audience',
      sub: hubId,
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(now.getTime() / 1000) + 900,
    });
  });

  it('the TTL is fixed at 900 s, independent of the user access-token TTL', async () => {
    const other = new JoseHubTokenService(
      config(SEED_A, {}, 'key-1', { AUTH_ACCESS_TOKEN_TTL_SECONDS: 60 }),
    );
    await other.onModuleInit();
    const { expiresAt } = await other.issue(hubId, now);
    expect(expiresAt).toEqual(new Date(now.getTime() + 900_000));
  });

  it('a user access token (typ at+jwt) is refused by the hub verifier', async () => {
    const { token } = await users.issue(
      { userId: newId(), sessionId: newId() },
      now,
    );
    await expect(svc.verify(token, now)).rejects.toMatchObject(INVALID);
  });

  it('a hub token is refused by the user access-token verifier', async () => {
    const { token } = await svc.issue(hubId, now);
    await expect(users.verify(token, now)).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'invalid-access-token',
    });
  });

  it('refuses another seed, garbage, a tampered token and a sub that is not a UUID v7', async () => {
    const foreign = new JoseHubTokenService(config(SEED_B));
    await foreign.onModuleInit();
    await expect(
      svc.verify((await foreign.issue(hubId, now)).token, now),
    ).rejects.toMatchObject(INVALID);
    await expect(svc.verify('nope', now)).rejects.toMatchObject(INVALID);
    const { token } = await svc.issue(hubId, now);
    const [head, , sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ ...decodeJwt(token), sub: newId() }),
    ).toString('base64url');
    await expect(
      svc.verify(`${head}.${forged}.${sig}`, now),
    ).rejects.toMatchObject(INVALID);
  });

  it('issue refuses a hub id that is not a UUID v7 (the same check as verify)', async () => {
    for (const bad of [
      'not-a-uuid',
      '',
      '6f1c2a34-5b6d-4e7f-8a9b-0c1d2e3f4a5b', // v4
    ]) {
      await expect(svc.issue(bad, now)).rejects.toThrow(/UUID v7/);
    }
  });

  it('refuses another issuer or audience', async () => {
    for (const over of [
      { AUTH_JWT_ISSUER: 'other-issuer' },
      { AUTH_JWT_AUDIENCE: 'other-audience' },
    ]) {
      const other = new JoseHubTokenService(config(SEED_A, {}, 'key-1', over));
      await other.onModuleInit();
      const { token } = await other.issue(hubId, now);
      await expect(svc.verify(token, now)).rejects.toMatchObject(INVALID);
    }
  });

  it('follows the key rotation of the user tokens (previous kid verifies, current kid signs)', async () => {
    const old = new JoseHubTokenService(config(SEED_B, {}, 'key-1'));
    await old.onModuleInit();
    const { token } = await old.issue(hubId, now);
    const next = new JoseHubTokenService(
      config(SEED_A, { AUTH_JWT_PREVIOUS_KEYS: `key-1:${SEED_B}` }, 'key-2'),
    );
    await next.onModuleInit();
    await expect(next.verify(token, now)).resolves.toEqual({ hubId });
    expect(
      decodeProtectedHeader((await next.issue(hubId, now)).token).kid,
    ).toBe('key-2');
    const dropped = new JoseHubTokenService(config(SEED_A, {}, 'key-2'));
    await dropped.onModuleInit();
    await expect(dropped.verify(token, now)).rejects.toMatchObject(INVALID);
  });

  it('fails fast at boot on a malformed seed', async () => {
    const bad = new JoseHubTokenService(config('short'));
    await expect(bad.onModuleInit()).rejects.toBeDefined();
  });
});
