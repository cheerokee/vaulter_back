import type { MyKeysView } from '../../../application/dto/my-keys-view.js';
import type { RecoveryCopiesView } from '../../../application/get-recovery-copies.use-case.js';
import type { PendingGrantView } from '../../../application/dto/pending-grant-view.js';
import type { SpaceMemberView } from '../../../application/dto/space-member-view.js';
import type {
  SpaceDetailsView,
  SpaceListItemView,
  SpaceSummaryView,
  SpaceView,
} from '../../../application/dto/space-view.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function spaceResponse(v: SpaceView | SpaceDetailsView) {
  return {
    id: v.id,
    organizationId: v.organizationId,
    name: v.name,
    roleKey: v.roleKey,
    currentKeyVersion: v.currentKeyVersion,
    keyRotationRequired: v.keyRotationRequired,
    recoveryRewrapRequired: v.recoveryRewrapRequired,
    ...('pendingGrants' in v && v.pendingGrants !== undefined
      ? { pendingGrants: v.pendingGrants }
      : {}),
    createdAt: iso(v.createdAt),
    updatedAt: iso(v.updatedAt),
  };
}

export function spaceListItemResponse(v: SpaceListItemView) {
  return {
    id: v.id,
    organizationId: v.organizationId,
    name: v.name,
    roleKey: v.roleKey,
    currentKeyVersion: v.currentKeyVersion,
    keyRotationRequired: v.keyRotationRequired,
    recoveryRewrapRequired: v.recoveryRewrapRequired,
    ...(v.pendingGrants !== undefined
      ? { pendingGrants: v.pendingGrants }
      : {}),
    createdAt: iso(v.createdAt),
  };
}

export function spaceSummaryResponse(v: SpaceSummaryView) {
  return {
    id: v.id,
    name: v.name,
    memberCount: v.memberCount,
    recoveryRewrapRequired: v.recoveryRewrapRequired,
    createdAt: iso(v.createdAt),
  };
}

export function spaceMemberResponse(v: SpaceMemberView) {
  return {
    userId: v.userId,
    name: v.name,
    email: v.email,
    publicKey: v.publicKey,
    roleKey: v.roleKey,
    joinedAt: v.joinedAt.toISOString(),
  };
}

export function myKeysResponse(v: MyKeysView) {
  return {
    currentVersion: v.currentVersion,
    keys: v.keys.map((k) => ({ version: k.version, wrappedKey: k.wrappedKey })),
  };
}

export function recoveryCopiesResponse(v: RecoveryCopiesView) {
  return {
    currentVersion: v.currentVersion,
    copies: v.copies.map((c) => ({
      version: c.version,
      recoveryWrappedKey: c.recoveryWrappedKey,
      recoveryKeyFingerprint: c.recoveryKeyFingerprint,
    })),
  };
}

export function pendingGrantResponse(v: PendingGrantView) {
  return {
    id: v.id,
    userId: v.userId,
    name: v.name,
    email: v.email,
    publicKey: v.publicKey,
    roleKey: v.roleKey,
    invitationId: v.invitationId,
    requestedByUserId: v.requestedByUserId,
    createdAt: v.createdAt.toISOString(),
  };
}
