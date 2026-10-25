import type { Space } from '../../domain/space.js';
import type { SpaceRoleKey } from '../../domain/space-membership.js';

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
  createdAt: Date | null;
  updatedAt: Date | null;
};

/** An item of "my spaces"; `pendingGrants` only for managers (omitted otherwise). */
export type SpaceListItemView = Omit<SpaceView, 'updatedAt'> & {
  pendingGrants?: number;
};

/** An item of `?all=true` (org.spaces.create): no role, no flags, nothing about keys. */
export type SpaceSummaryView = {
  id: string;
  name: string;
  memberCount: number;
  createdAt: Date | null;
};

export function toSpaceView(
  space: Space,
  roleKey: SpaceRoleKey,
  recoveryRewrapRequired: boolean,
): SpaceView {
  return {
    id: space.id,
    organizationId: space.organizationId,
    name: space.name,
    roleKey,
    currentKeyVersion: space.currentKeyVersion,
    keyRotationRequired: space.keyRotationRequired,
    recoveryRewrapRequired,
    createdAt: space.createdAt ?? null,
    updatedAt: space.updatedAt ?? null,
  };
}
