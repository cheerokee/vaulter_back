import type { ConfigService } from '@nestjs/config';
import {
  importJWK,
  jwtVerify,
  type CryptoKey,
  type JWTHeaderParameters,
  type JWTPayload,
} from 'jose';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';

type Key = CryptoKey | Uint8Array;

/**
 * Signing and verification keys of every JWT the API issues (user and hub access tokens), from the `.env`:
 * `AUTH_JWT_SIGNING_SEED` + `AUTH_JWT_KEY_ID` sign; `AUTH_JWT_PREVIOUS_KEYS` (`kid:seed,...`) only verify
 * (rotation in 3 phases, see CLAUDE.md). `iss`/`aud` are the same for every token; each token kind pins its `typ`.
 */
export class JwtKeyRing {
  private privateKey?: Key;
  private readonly publicKeys = new Map<string, Key>();

  constructor(private readonly config: ConfigService) {}

  /** Derives every key: a bad seed fails startup instead of every request. */
  async load(): Promise<void> {
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
    this.publicKeys.set(this.keyId, current.publicKey);
    const previous = this.config.get<string>('AUTH_JWT_PREVIOUS_KEYS');
    for (const item of previous ? previous.split(',') : []) {
      const sep = item.indexOf(':');
      const kid = item.slice(0, sep);
      if (sep <= 0 || this.publicKeys.has(kid)) {
        throw new Error('Invalid AUTH_JWT_PREVIOUS_KEYS');
      }
      this.publicKeys.set(
        kid,
        (await derive(item.slice(sep + 1), false)).publicKey,
      );
    }
  }

  get keyId(): string {
    return this.config.getOrThrow<string>('AUTH_JWT_KEY_ID');
  }
  get issuer(): string {
    return this.config.getOrThrow<string>('AUTH_JWT_ISSUER');
  }
  get audience(): string {
    return this.config.getOrThrow<string>('AUTH_JWT_AUDIENCE');
  }

  signingKey(): Key {
    if (!this.privateKey) throw new Error('JwtKeyRing not initialised');
    return this.privateKey;
  }

  /** Verifies signature (by `kid`), EdDSA, `iss`, `aud`, `typ` and expiry; throws on any failure. */
  async verify(token: string, typ: string, now: Date): Promise<JWTPayload> {
    const getKey = (header: JWTHeaderParameters) => {
      const key = header.kid ? this.publicKeys.get(header.kid) : undefined;
      if (!key) throw new Error('unknown kid');
      return key;
    };
    const { payload } = await jwtVerify(token, getKey, {
      algorithms: ['EdDSA'],
      issuer: this.issuer,
      audience: this.audience,
      typ,
      currentDate: now,
    });
    return payload;
  }
}
