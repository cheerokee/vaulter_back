import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT } from 'jose';
import { UnauthenticatedError } from '../../../shared/domain/errors.js';
import { isUuidV7 } from '../../../shared/domain/id.js';
import { HubTokenService } from '../../application/hub-token-service.js';
import { JwtKeyRing } from './jwt-key-ring.js';

/** 15 minutes (decision 4 of the hubs plan); independent of the user access-token TTL. */
export const HUB_TOKEN_TTL_SECONDS = 900;
const HUB_TOKEN_TYP = 'hub+jwt';

// Token de Hub: JWT EdDSA com as mesmas chaves e rotação por `kid` do token de usuário (JwtKeyRing), o mesmo
// `iss`/`aud`, `sub` = id do Hub e `typ: hub+jwt` — o verificador de usuário fixa `at+jwt` e este fixa `hub+jwt`,
// então um nunca passa no lugar do outro.
@Injectable()
export class JoseHubTokenService
  extends HubTokenService
  implements OnModuleInit
{
  private readonly keys: JwtKeyRing;

  constructor(config: ConfigService) {
    super();
    this.keys = new JwtKeyRing(config);
  }

  async onModuleInit(): Promise<void> {
    await this.keys.load();
  }

  async issue(
    hubId: string,
    now: Date = new Date(),
  ): Promise<{ token: string; expiresAt: Date }> {
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + HUB_TOKEN_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({
        alg: 'EdDSA',
        kid: this.keys.keyId,
        typ: HUB_TOKEN_TYP,
      })
      .setAudience(this.keys.audience)
      .setIssuer(this.keys.issuer)
      .setSubject(hubId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.keys.signingKey());
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async verify(
    token: string,
    now: Date = new Date(),
  ): Promise<{ hubId: string }> {
    try {
      const { sub } = await this.keys.verify(token, HUB_TOKEN_TYP, now);
      if (typeof sub !== 'string' || !isUuidV7(sub)) {
        throw new Error('invalid claims');
      }
      return { hubId: sub };
    } catch {
      throw new UnauthenticatedError('invalid-hub-token', 'Invalid hub token');
    }
  }
}
