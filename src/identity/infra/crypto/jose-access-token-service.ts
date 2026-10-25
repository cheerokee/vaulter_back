import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { importJWK, jwtVerify, SignJWT, type CryptoKey } from 'jose';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import { isUuidV7 } from '../../../shared/domain/id.js';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import {
  AccessTokenClaims,
  AccessTokenService,
} from '../../application/ports/access-token-service.js';

@Injectable()
export class JoseAccessTokenService
  extends AccessTokenService
  implements OnModuleInit
{
  private keys?: {
    privateKey: CryptoKey | Uint8Array;
    publicKey: CryptoKey | Uint8Array;
  };

  constructor(private readonly config: ConfigService) {
    super();
  }

  /** Derives the signing keys at boot: a bad seed fails startup instead of every request. */
  async onModuleInit(): Promise<void> {
    const sodium = await getSodium();
    const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
    const seedText = this.config.getOrThrow<string>('AUTH_JWT_SIGNING_SEED');
    const { publicKey } = sodium.crypto_sign_seed_keypair(
      sodium.from_base64(seedText, B64),
    );
    const x = sodium.to_base64(publicKey, B64);
    const jwk = { kty: 'OKP', crv: 'Ed25519', x };
    this.keys = {
      privateKey: await importJWK({ ...jwk, d: seedText }, 'EdDSA'),
      publicKey: await importJWK(jwk, 'EdDSA'),
    };
  }

  private loadKeys(): NonNullable<typeof this.keys> {
    if (!this.keys) throw new Error('JoseAccessTokenService not initialised');
    return this.keys;
  }

  async issue(
    claims: AccessTokenClaims,
    now: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const ttl = Number(
      this.config.getOrThrow<number>('AUTH_ACCESS_TOKEN_TTL_SECONDS'),
    );
    const iat = Math.floor(now.getTime() / 1000);
    const token = await new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({
        alg: 'EdDSA',
        kid: this.config.getOrThrow<string>('AUTH_JWT_KEY_ID'),
      })
      .setIssuer(this.config.getOrThrow<string>('AUTH_JWT_ISSUER'))
      .setSubject(claims.userId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .sign(this.loadKeys().privateKey);
    return { token, expiresAt: new Date((iat + ttl) * 1000) };
  }

  async verify(token: string, now: Date): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.loadKeys().publicKey, {
        algorithms: ['EdDSA'],
        issuer: this.config.getOrThrow<string>('AUTH_JWT_ISSUER'),
        currentDate: now,
      });
      const { sub, sid } = payload;
      if (
        typeof sub !== 'string' ||
        typeof sid !== 'string' ||
        !isUuidV7(sub) ||
        !isUuidV7(sid)
      ) {
        throw new Error('invalid claims');
      }
      return { userId: sub, sessionId: sid };
    } catch {
      throw new UnauthenticatedError(
        'invalid-access-token',
        'Invalid access token',
      );
    }
  }
}
