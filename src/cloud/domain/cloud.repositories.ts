import type { CloudTerm, CloudTermAcceptance } from './cloud-term.js';
import type { SpaceActivation } from './space-activation.js';

/** Published terms (server data, read-only for the runtime: new versions come by migration). */
export abstract class CloudTermRepository {
  /** The highest published version, or null when none was published. */
  abstract current(): Promise<CloudTerm | null>;
}

/** Acceptances of the term by organizations (append-only). Every method sets the RLS context of `orgId`. */
export abstract class CloudTermAcceptanceRepository {
  /** The acceptance of the most recent version the organization accepted, or null. */
  abstract latest(orgId: string): Promise<CloudTermAcceptance | null>;
  /**
   * Records the acceptance unless the organization already accepted that version (concurrent accepts: one row).
   * Returns the stored acceptance and whether this call created it.
   */
  abstract acceptOnce(
    acceptance: CloudTermAcceptance & { ip: string | null },
  ): Promise<{ acceptance: CloudTermAcceptance; created: boolean }>;
}

/** Activation cycles of the spaces (at most one live row per space). */
export abstract class SpaceActivationRepository {
  /** The live cycle of the space, without a lock. */
  abstract findLive(
    orgId: string,
    spaceId: string,
  ): Promise<SpaceActivation | null>;
  /**
   * The live cycle `FOR UPDATE`. REQUIRES a unit of work; lock order: after the space row (every cloud operation
   * locks the space first).
   */
  abstract lockLive(
    orgId: string,
    spaceId: string,
  ): Promise<SpaceActivation | null>;
  abstract insert(activation: SpaceActivation): Promise<void>;
  /** Writes the state and who/when switched it on. */
  abstract save(activation: SpaceActivation): Promise<void>;
  /** Ends the cycle (tombstone with who/when switched off). */
  abstract end(
    activation: SpaceActivation,
    byUserId: string,
    at: Date,
  ): Promise<void>;
}

/**
 * The space key versions sealed for the server key. Legible once opened: switching off DELETES them for real (no
 * tombstone, the documented exception to the soft-delete rule).
 */
export abstract class ServerKeyGrantRepository {
  abstract insert(grant: {
    organizationId: string;
    spaceId: string;
    spaceKeyId: string;
    keyVersion: number;
    wrappedKey: string;
  }): Promise<void>;
  /** Every copy of the space (one per key version). */
  abstract findForSpace(
    orgId: string,
    spaceId: string,
  ): Promise<{ keyVersion: number; wrappedKey: string }[]>;
  /** Physical DELETE of every copy of the space; returns how many. */
  abstract deleteForSpace(orgId: string, spaceId: string): Promise<number>;
}
