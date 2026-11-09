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
  /**
   * Names of ACTIVE hubs, read in each hub's own context (trusted backend read: authorization is the caller's job;
   * an org admin listing pending requests does not see the hub through the RLS yet). Missing or deregistered ids
   * are left out of the map.
   */
  abstract namesOf(hubIds: readonly string[]): Promise<Map<string, string>>;
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
  /**
   * SELECT ... FOR SHARE on an ACTIVE hub (null when missing or deregistered), in the hub's own context, so any
   * caller can take it (authorization is the use case's job). REQUIRES an active unit of work. The first lock of
   * every link mutation (hub -> link -> hub_space -> space): it serializes with deregistration (FOR UPDATE).
   */
  abstract lockForShare(hubId: string): Promise<Hub | null>;
  /**
   * `SELECT ... FOR NO KEY UPDATE` on an ACTIVE hub (null when missing or deregistered), in the hub's own context.
   * REQUIRES an active unit of work. Everything that reads or changes what is installed against the capacity takes
   * it FIRST (same place as `lockForShare` in the order): installs serialize on it (two installs never both fit in the
   * same room), and a space resize locks every hub the space is on. Conflicts with `lockForShare`/`lockForUpdate`;
   * FK checks (`FOR KEY SHARE`) do not wait for it. `nowait`: a hub locked by someone else is 409
   * `hub-storage-busy` instead of waiting (a resize that found a new hub only after locking the space).
   */
  abstract lockForStorage(
    hubId: string,
    opts?: { nowait?: boolean },
  ): Promise<Hub | null>;
  /** Writes only the reported capacity of an ACTIVE hub (no read-modify-write of the row); false when none. */
  abstract setStorageCapacity(hubId: string, bytes: number): Promise<boolean>;
}
