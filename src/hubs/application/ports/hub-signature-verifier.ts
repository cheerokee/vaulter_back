import type {
  HubLabel,
  HubSignedFields,
} from '../../domain/hub-signed-message.js';

/** Port: verifies a Hub's detached Ed25519 signature over a labelled message. Never throws on bad input. */
export abstract class HubSignatureVerifier {
  abstract verify(
    label: HubLabel,
    fields: HubSignedFields,
    signatureB64u: string,
    signingPublicKeyB64u: string,
  ): Promise<boolean>;

  /**
   * A valid Ed25519 public key whose private key nobody holds (random at provider init, never persisted). Verify
   * against it when the real key is unknown (missing hub or enrollment): the work, and the time, match a real
   * verification, and the result is always false. The single decoy for every hub use case.
   */
  abstract decoyPublicKey(): string;
}
