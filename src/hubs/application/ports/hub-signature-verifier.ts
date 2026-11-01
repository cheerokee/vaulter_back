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
}
