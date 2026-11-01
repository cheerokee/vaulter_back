import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import { isUuidV7 } from '../../../shared/domain/id.js';
import {
  AccessTokenClaims,
  AccessTokenService,
} from '../../application/ports/access-token-service.js';
import { JwtKeyRing } from './jwt-key-ring.js';

@Injectable()
export class JoseAccessTokenService
  extends AccessTokenService
  implements OnModuleInit
{
  private readonly keys: JwtKeyRing;

  constructor(private readonly config: ConfigService) {
    super();
    this.keys = new JwtKeyRing(config);
  }

  /** Derives every key at boot: a bad seed fails startup instead of every request. */
  async onModuleInit(): Promise<void> {
    await this.keys.load();
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
        kid: this.keys.keyId,
        typ: 'at+jwt',
      })
      .setAudience(this.keys.audience)
      .setIssuer(this.keys.issuer)
      .setSubject(claims.userId)
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttl)
      .sign(this.keys.signingKey());
    return { token, expiresAt: new Date((iat + ttl) * 1000) };
  }

  // `typ` fixo em at+jwt: um token de Hub (hub+jwt), assinado com as mesmas chaves, nunca passa aqui.
  async verify(token: string, now: Date): Promise<AccessTokenClaims> {
    try {
      const { sub, sid } = await this.keys.verify(token, 'at+jwt', now);
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
