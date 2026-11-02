import { Injectable } from '@nestjs/common';
import { getSodium } from '../../../shared/infra/crypto/sodium.js';
import { HubSignatureVerifier } from '../../application/ports/hub-signature-verifier.js';
import {
  hubSignedBytes,
  type HubLabel,
  type HubSignedFields,
} from '../../domain/hub-signed-message.js';

const sodium = await getSodium();
const B64 = sodium.base64_variants.URLSAFE_NO_PADDING;

// Strict base64url: canonical encoding and exact decoded length; null on any malformation.
function decode(value: unknown, size: number): Uint8Array | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const bytes = sodium.from_base64(value, B64);
    if (bytes.length !== size || sodium.to_base64(bytes, B64) !== value)
      return null;
    return bytes;
  } catch {
    return null;
  }
}

@Injectable()
export class SodiumHubSignatureVerifier extends HubSignatureVerifier {
  // Um par Ed25519 aleatório por instância: um ponto válido, de ordem cheia (uma chave fixa como 'A'.repeat(43) é de
  // ordem pequena e a libsodium a recusa antes de verificar, o que daria uma diferença de tempo). A chave privada é
  // descartada na hora.
  private readonly decoy = sodium.to_base64(
    sodium.crypto_sign_keypair().publicKey,
    B64,
  );

  decoyPublicKey(): string {
    return this.decoy;
  }

  verify(
    label: HubLabel,
    fields: HubSignedFields,
    signatureB64u: string,
    signingPublicKeyB64u: string,
  ): Promise<boolean> {
    const signature = decode(signatureB64u, sodium.crypto_sign_BYTES);
    const publicKey = decode(
      signingPublicKeyB64u,
      sodium.crypto_sign_PUBLICKEYBYTES,
    );
    if (!signature || !publicKey) return Promise.resolve(false);
    try {
      return Promise.resolve(
        sodium.crypto_sign_verify_detached(
          signature,
          hubSignedBytes(label, fields),
          publicKey,
        ),
      );
    } catch {
      return Promise.resolve(false);
    }
  }
}
