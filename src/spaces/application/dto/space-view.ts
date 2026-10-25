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

/** `GET /spaces/:id`: the details plus, for managers only, the open pending grants count. */
export type SpaceDetailsView = SpaceView & { pendingGrants?: number };

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
