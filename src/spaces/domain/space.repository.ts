import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { Space } from './space.js';
import type { SpaceRoleKey } from './space-membership.js';

export type SpaceListItem = {
  space: Space;
  roleKey: SpaceRoleKey;
  /** space.keyRotationRequired, repeated here for list consumers. */
  keyRotationRequired: boolean;
  /**
   * True when any key version has a recovery_key_fingerprint different from the current kit's. False when
   * the organization has no kit (nothing can be rewrapped).
   */
  recoveryRewrapRequired: boolean;
  /** pending lock-ins; only meaningful for managers. */
  pendingGrants: number;
};

export type SpaceSummary = {
  space: Space;
  memberCount: number;
};

/** Every method takes `orgId` first: it sets the RLS context and scopes the query. */
export abstract class SpaceRepository {
  abstract create(space: Space): Promise<void>;
  abstract save(space: Space): Promise<void>;
  abstract findById(orgId: string, spaceId: string): Promise<Space | null>;
  /**
   * Reads the space with `SELECT ... FOR UPDATE`. REQUIRES an active unit of work: key rotation and adding
   * members must serialize on it so nobody is left out of a new key version.
   */
  abstract lockForUpdate(orgId: string, spaceId: string): Promise<Space | null>;
  /** Spaces where the user is an active member. */
  abstract listForMember(
    orgId: string,
    userId: string,
    currentKitFingerprint: string | null,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceListItem>>;
  /** Every space of the organization, with the active member count (needs `org.spaces.create`). */
  abstract listAll(
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceSummary>>;
}
