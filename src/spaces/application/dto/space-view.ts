import type { CloudMode, Space } from '../../domain/space.js';
import type { SpaceRoleKey } from '../../domain/space-membership.js';

/**
 * Reserved size and usage (every stored version, trash included), in bytes. `trashBytes` (only on `GET /spaces/:id`):
 * the part of `usedBytes` in the trash (old and deleted versions inside the 30-day window).
 */
export type SpaceStorageView = {
  quotaBytes: number;
  usedBytes: number;
  trashBytes?: number;
};

/** Details of a space for one of its members. */
export type SpaceView = {
  id: string;
  organizationId: string;
  name: string;
  /** The caller's role in the space. */
  roleKey: SpaceRoleKey;
  currentKeyVersion: number;
  /** Someone left: the next key version must be generated without them. */
  keyRotationRequired: boolean;
  /** Some key version is still wrapped for a previous recovery kit. */
  recoveryRewrapRequired: boolean;
  /** Present on create, `GET /spaces/:id` and the resize (where the usage is read). */
  storage?: SpaceStorageView;
  createdAt: Date | null;
  updatedAt: Date | null;
};

/** A hub with the space open in its Room (the `hubs` module owns the hub: here it is just an id). */
export type RoomHubView = { hubId: string; roleKey: SpaceRoleKey };

/**
 * Cloud mode of the space, for every member: in `active_cloud` the app shows a permanent notice that the server reads
 * the space, and a key rotation must include the server copy. `activatedAt` is null in `encrypted_backup`.
 */
export type SpaceCloudView = { mode: CloudMode; activatedAt: Date | null };

/**
 * `GET /spaces/:id`: the details, the Room hubs (every member: rotating the key needs one copy per Room hub), the
 * cloud mode and, for managers only, the open pending grants count.
 */
export type SpaceDetailsView = SpaceView & {
  roomHubs: RoomHubView[];
  cloud: SpaceCloudView;
  pendingGrants?: number;
};

/** An item of "my spaces"; `pendingGrants` only for managers (omitted otherwise). */
export type SpaceListItemView = Omit<SpaceView, 'updatedAt'> & {
  pendingGrants?: number;
};

/** An item of `?all=true` (org.spaces.create): no role and no key material. */
export type SpaceSummaryView = {
  id: string;
  name: string;
  /** Active members; 0 = orphan (only an admin can reopen it with the kit). */
  memberCount: number;
  /** Some version is still wrapped for a previous kit (false when the organization has no kit). */
  recoveryRewrapRequired: boolean;
  createdAt: Date | null;
};

export function toSpaceView(
  space: Space,
  roleKey: SpaceRoleKey,
  recoveryRewrapRequired: boolean,
  usedBytes?: number,
): SpaceView {
  return {
    id: space.id,
    organizationId: space.organizationId,
    name: space.name,
    roleKey,
    currentKeyVersion: space.currentKeyVersion,
    keyRotationRequired: space.keyRotationRequired,
    recoveryRewrapRequired,
    ...(usedBytes !== undefined
      ? { storage: { quotaBytes: space.storageQuotaBytes, usedBytes } }
      : {}),
    createdAt: space.createdAt ?? null,
    updatedAt: space.updatedAt ?? null,
  };
}
