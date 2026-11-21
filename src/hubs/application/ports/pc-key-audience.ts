import type { HubKind } from '../../domain/hub.js';

/** What a non-owner may read of a `pc` hub: its identity and public key, nothing else (no role, no owner fields). */
export type HubKeyView = {
  id: string;
  name: string;
  kind: HubKind;
  encryptionPublicKey: string;
};

/**
 * Narrow lookup for the public key of a `pc` hub (agent) by someone who is NOT its owner. `HubAccess` stays owner-only
 * for a `pc`; this is only the source of the key that others must wrap copies to: a member of a space where the `pc`
 * is in the Room (key rotation `hubGrants`) and a participant of a conversation the `pc` executes. Null otherwise
 * (owner, appliance, deregistered, missing, malformed id): the caller answers the same 404 `hub-not-found`.
 */
export abstract class PcKeyAudience {
  abstract findKeyView(
    hubId: string,
    userId: string,
  ): Promise<HubKeyView | null>;
}
