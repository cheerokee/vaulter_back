import type { ConfigService } from '@nestjs/config';
import { decodeProtectedHeader } from 'jose';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import { newId } from '../../../shared/domain/id.js';
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

describe('JoseAccessTokenService', () => {
  const svc = new JoseAccessTokenService(config(SEED_A));
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
    const { token } = await new JoseAccessTokenService(config(SEED_B)).issue(
      claims,
      now,
    );
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
});
