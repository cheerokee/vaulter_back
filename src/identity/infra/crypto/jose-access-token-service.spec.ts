import type { ConfigService } from '@nestjs/config';
import { decodeProtectedHeader, importJWK, SignJWT } from 'jose';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import { newId } from '../../../shared/domain/id.js';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { JoseAccessTokenService } from './jose-access-token-service.js';

const SEED_A = 'A'.repeat(42) + 'A';
const SEED_B = 'B'.repeat(42) + 'A';
const config = (seed: string) =>
  ({
    getOrThrow: (k: string) =>
      ({
        AUTH_JWT_ISSUER: 'test-issuer',
        AUTH_JWT_KEY_ID: 'key-1',
        AUTH_JWT_SIGNING_SEED: seed,
        AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
      })[k],
  }) as unknown as ConfigService;
const b64 = (o: unknown) =>
  Buffer.from(JSON.stringify(o)).toString('base64url');

async function signRaw(
  seed: string,
  payload: Record<string, unknown>,
  issuer: string,
  subject?: string,
): Promise<string> {
  const sodium = await getSodium();
  const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
  const { publicKey } = sodium.crypto_sign_seed_keypair(
    sodium.from_base64(seed, B64),
  );
  const key = await importJWK(
    {
      kty: 'OKP',
      crv: 'Ed25519',
      x: sodium.to_base64(publicKey, B64),
      d: seed,
    },
    'EdDSA',
  );
  const jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'key-1' })
    .setIssuer(issuer)
    .setIssuedAt(1792843200)
    .setExpirationTime(1792844100);
  if (subject) jwt.setSubject(subject);
  return jwt.sign(key);
}

describe('JoseAccessTokenService', () => {
  const svc = new JoseAccessTokenService(config(SEED_A));
  beforeAll(async () => {
    await svc.onModuleInit();
  });
  const now = new Date('2026-10-24T12:00:00Z');
  const claims = { userId: newId(), sessionId: newId() };

  it('round-trips claims and reports expiry', async () => {
    const { token, expiresAt } = await svc.issue(claims, now);
    expect(expiresAt).toEqual(new Date(now.getTime() + 900_000));
    expect(await svc.verify(token, now)).toEqual(claims);
  });

  it('puts kid and EdDSA in the header', async () => {
    const { token } = await svc.issue(claims, now);
    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: 'EdDSA',
      kid: 'key-1',
    });
  });

  it('rejects an expired token', async () => {
    const { token } = await svc.issue(claims, now);
    const later = new Date(now.getTime() + 901_000);
    await expect(svc.verify(token, later)).rejects.toMatchObject({
      constructor: UnauthenticatedError,
      code: 'invalid-access-token',
    });
  });

  it('rejects a token signed with another seed', async () => {
    const other = new JoseAccessTokenService(config(SEED_B));
    await other.onModuleInit();
    const { token } = await other.issue(claims, now);
    await expect(svc.verify(token, now)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('rejects alg none', async () => {
    const token = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
      iss: 'test-issuer',
      sub: claims.userId,
      sid: claims.sessionId,
      iat: 1792843200,
      exp: 1792844100,
    })}.`;
    await expect(svc.verify(token, now)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('rejects a tampered payload', async () => {
    const { token } = await svc.issue(claims, now);
    const [h, , s] = token.split('.');
    const forged = b64({
      iss: 'test-issuer',
      sub: newId(),
      sid: claims.sessionId,
      iat: 1792843200,
      exp: 1792844100,
    });
    await expect(svc.verify(`${h}.${forged}.${s}`, now)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('rejects garbage', async () => {
    await expect(svc.verify('nope', now)).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('rejects a token signed with the right seed but another issuer', async () => {
    const token = await signRaw(
      SEED_A,
      { sid: claims.sessionId },
      'other-issuer',
      claims.userId,
    );
    await expect(svc.verify(token, now)).rejects.toMatchObject({
      code: 'invalid-access-token',
    });
  });

  it('rejects a validly signed token without sid', async () => {
    const token = await signRaw(SEED_A, {}, 'test-issuer', claims.userId);
    await expect(svc.verify(token, now)).rejects.toMatchObject({
      code: 'invalid-access-token',
    });
  });

  it('rejects a validly signed token without sub', async () => {
    const token = await signRaw(
      SEED_A,
      { sid: claims.sessionId },
      'test-issuer',
    );
    await expect(svc.verify(token, now)).rejects.toMatchObject({
      code: 'invalid-access-token',
    });
  });

  it('rejects a validly signed token whose sub or sid is not a UUID v7', async () => {
    const token = await signRaw(
      SEED_A,
      { sid: 'not-a-uuid' },
      'test-issuer',
      claims.userId,
    );
    await expect(svc.verify(token, now)).rejects.toMatchObject({
      code: 'invalid-access-token',
    });
  });

  it('fails fast at boot on a malformed seed', async () => {
    const bad = new JoseAccessTokenService(config('short'));
    await expect(bad.onModuleInit()).rejects.toBeDefined();
  });
});
