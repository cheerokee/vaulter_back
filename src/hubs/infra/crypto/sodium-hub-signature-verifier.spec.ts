import {
  createHubIdentity,
  signAuth,
  signEnrollment,
  signHubMessage,
  signStatus,
} from '../../../../test/support/hub-crypto.js';
import {
  HUB_LABELS,
  type HubSignedFields,
} from '../../domain/hub-signed-message.js';
import { SodiumHubSignatureVerifier } from './sodium-hub-signature-verifier.js';

const verifier = new SodiumHubSignatureVerifier();

// Fixed vector from docs/crypto/hub-identity.md.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const VECTOR = {
  signingPublicKey: 'A6EHv_POEL4dcN0Y50vAmWfk1jCbpQ1fHdyGZBJVMbg',
  encryptionPublicKey: 'RwHQhIhFH1RaQJ-1iuPlhYHKQKw_fxFGmM1x3qxzygE',
  nonce: 'AAECAwQFBgcICQoLDA0ODw',
  timestamp: '2026-11-01T12:00:00.000Z',
  signature:
    '8wQttPW9-f7bcvb-5wDeT6bwGU8ZHApDzVzrIPUCBmu79BY7I48NLHSkt20zeXRvzwBAYj8zOahLR-t4Si94Ag',
};

describe('SodiumHubSignatureVerifier', () => {
  it('verifies the fixed test vector (and the client reproduces it)', async () => {
    const { signature, ...fields } = VECTOR;
    const id = await createHubIdentity(SEED);
    expect(id.signingPublicKey).toBe(VECTOR.signingPublicKey);
    expect(id.encryptionPublicKey).toBe(VECTOR.encryptionPublicKey);
    expect(
      await signEnrollment(id, {
        nonce: VECTOR.nonce,
        timestamp: VECTOR.timestamp,
      }),
    ).toBe(signature);
    expect(
      await verifier.verify(
        HUB_LABELS.enroll,
        fields,
        signature,
        VECTOR.signingPublicKey,
      ),
    ).toBe(true);
  });

  it('verifies status and auth messages regardless of key order', async () => {
    const id = await createHubIdentity();
    const status = { enrollmentId: 'e1', timestamp: 't' };
    const auth = { hubId: 'h1', challenge: 'c' };
    expect(
      await verifier.verify(
        HUB_LABELS.status,
        { timestamp: 't', enrollmentId: 'e1' },
        await signStatus(id, status),
        id.signingPublicKey,
      ),
    ).toBe(true);
    expect(
      await verifier.verify(
        HUB_LABELS.auth,
        { challenge: 'c', hubId: 'h1' },
        await signAuth(id, auth),
        id.signingPublicKey,
      ),
    ).toBe(true);
  });

  it('rejects another label, a tampered field and the wrong key', async () => {
    const id = await createHubIdentity();
    const other = await createHubIdentity();
    const fields = { hubId: 'h1', challenge: 'c' };
    const sig = await signAuth(id, fields);
    const ok = (l: string, f: HubSignedFields, s: string, k: string) =>
      verifier.verify(l as never, f, s, k);
    expect(await ok(HUB_LABELS.auth, fields, sig, id.signingPublicKey)).toBe(
      true,
    );
    expect(await ok(HUB_LABELS.status, fields, sig, id.signingPublicKey)).toBe(
      false,
    );
    expect(
      await ok(
        HUB_LABELS.auth,
        { ...fields, challenge: 'd' },
        sig,
        id.signingPublicKey,
      ),
    ).toBe(false);
    expect(await ok(HUB_LABELS.auth, fields, sig, other.signingPublicKey)).toBe(
      false,
    );
    expect(
      await verifier.verify(
        HUB_LABELS.auth,
        fields,
        await signHubMessage(id, 'other-v1', fields),
        id.signingPublicKey,
      ),
    ).toBe(false);
  });

  it('returns false, never throws, on malformed signature or key', async () => {
    const id = await createHubIdentity();
    const fields = { hubId: 'h1', challenge: 'c' };
    const sig = await signAuth(id, fields);
    for (const [s, k] of [
      ['', id.signingPublicKey],
      ['!!!', id.signingPublicKey],
      [sig.slice(1), id.signingPublicKey],
      [sig + '=', id.signingPublicKey],
      [sig, ''],
      [sig, 'short'],
      [sig, id.signingPublicKey.slice(1)],
      [42 as unknown as string, id.signingPublicKey],
      [sig, null as unknown as string],
    ] as const) {
      expect(await verifier.verify(HUB_LABELS.auth, fields, s, k)).toBe(false);
    }
  });
});
