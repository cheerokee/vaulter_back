import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  importJWK,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTHeaderParameters,
} from 'jose';
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
  private privateKey?: CryptoKey | Uint8Array;
  private readonly publicKeys = new Map<string, CryptoKey | Uint8Array>();

  constructor(private readonly config: ConfigService) {
    super();
  }

  /** Derives every key at boot: a bad seed fails startup instead of every request. */
  async onModuleInit(): Promise<void> {
    const sodium = await getSodium();
    const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;
    const derive = async (seedText: string, withPrivate: boolean) => {
      const { publicKey } = sodium.crypto_sign_seed_keypair(
        sodium.from_base64(seedText, B64),
      );
      const jwk = {
        kty: 'OKP',
        crv: 'Ed25519',
        x: sodium.to_base64(publicKey, B64),
      };
      return {
        privateKey: withPrivate
          ? await importJWK({ ...jwk, d: seedText }, 'EdDSA')
          : undefined,
        publicKey: await importJWK(jwk, 'EdDSA'),
      };
    };
    const current = await derive(
      this.config.getOrThrow<string>('AUTH_JWT_SIGNING_SEED'),
      true,
    );
    this.privateKey = current.privateKey;
    this.publicKeys.clear();
    this.publicKeys.set(
      this.config.getOrThrow<string>('AUTH_JWT_KEY_ID'),
      current.publicKey,
    );
    const previous = this.config.get<string>('AUTH_JWT_PREVIOUS_KEYS');
    for (const item of previous ? previous.split(',') : []) {
      const sep = item.indexOf(':');
      const kid = item.slice(0, sep);
      if (sep <= 0 || this.publicKeys.has(kid)) {
        throw new Error('Invalid AUTH_JWT_PREVIOUS_KEYS');
      }
      this.publicKeys.set(kid, (await derive(item.slice(sep + 1), false)).publicKey);
    }
  }

  private loadPrivateKey(): CryptoKey | Uint8Array {
    if (!this.privateKey) {
      throw new Error('JoseAccessTokenService not initialised');
    }
    return this.privateKey;
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
        typ: 'at+jwt',
      })
      .setAudience(this.config.getOrThrow<string>('AUTH_JWT_AUDIENCE'))
      .setIssuer(this.config.getOrThrow<string>('AUTH_JWT_ISSUER'))
      .setSubject(claims.userId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .sign(this.loadPrivateKey());
    return { token, expiresAt: new Date((iat + ttl) * 1000) };
  }

  async verify(token: string, now: Date): Promise<AccessTokenClaims> {
    try {
      const getKey = (header: JWTHeaderParameters) => {
        const key = header.kid ? this.publicKeys.get(header.kid) : undefined;
        if (!key) throw new Error('unknown kid');
        return key;
      };
      const { payload } = await jwtVerify(token, getKey, {
        algorithms: ['EdDSA'],
        issuer: this.config.getOrThrow<string>('AUTH_JWT_ISSUER'),
        audience: this.config.getOrThrow<string>('AUTH_JWT_AUDIENCE'),
        typ: 'at+jwt',
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
