import type {
  CursorPage,
  CursorPageRequest,
} from '../../shared/domain/pagination.js';
import type { Hub } from './hub.js';

export abstract class HubRepository {
  /** Throws ConflictError('signing-key-in-use') when a hub (even a deregistered one) already has the key. */
  abstract create(hub: Hub): Promise<void>;
  abstract save(hub: Hub): Promise<void>;
  /** Includes deregistered hubs (check `isDeregistered`). */
  abstract findById(hubId: string): Promise<Hub | null>;
  /** Includes deregistered hubs: the key is unique forever. */
  abstract findBySigningKey(signingPublicKey: string): Promise<Hub | null>;
  /** Hubs the user owns or reaches through an approved link; active ones only. */
  abstract listForUser(
    userId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<Hub>>;
  /**
   * SELECT ... FOR UPDATE. REQUIRES an active unit of work. Lock order: the hub row first, then the
   * hub_organization rows, then spaces. Deregistration takes this lock before tombstoning, and
   * `HubOrganizationRepository.upsert` takes the hub row FOR SHARE, so a link can never be created or revived
   * for a hub that is being deregistered.
   */
  abstract lockForUpdate(hubId: string): Promise<Hub | null>;
}
