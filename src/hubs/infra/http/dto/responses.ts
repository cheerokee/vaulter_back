import type {
  HubLinkRequestView,
  HubLinkView,
  HubSpaceView,
} from '../../../application/dto/hub-link-view.js';
import type {
  HubView,
  HubWithRoleView,
} from '../../../application/dto/hub-view.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/** The hub as its owner gets it from the claim. Never the signing key (it is the device's identity, not needed). */
export function hubResponse(v: HubView) {
  return {
    id: v.id,
    name: v.name,
    ownerUserId: v.ownerUserId,
    encryptionPublicKey: v.encryptionPublicKey,
    lastSeenAt: iso(v.lastSeenAt),
    createdAt: iso(v.createdAt),
  };
}

/** The hub as seen by one user, with their role on it. */
export function hubWithRoleResponse(v: HubWithRoleView) {
  return { ...hubResponse(v), role: v.role };
}

export function hubLinkResponse(v: HubLinkView) {
  return {
    hubId: v.hubId,
    organizationId: v.organizationId,
    status: v.status,
    requestedByUserId: v.requestedByUserId,
    ownerApprovedAt: iso(v.ownerApprovedAt),
    orgApprovedAt: iso(v.orgApprovedAt),
    createdAt: iso(v.createdAt),
  };
}

/** What the requester of a link learns: never the hub id. */
export function hubLinkRequestResponse(v: HubLinkRequestView) {
  return { organizationId: v.organizationId, status: v.status };
}

export function hubSpaceResponse(v: HubSpaceView) {
  return {
    hubId: v.hubId,
    spaceId: v.spaceId,
    organizationId: v.organizationId,
    addedByUserId: v.addedByUserId,
  };
}

/** The Room grant: who (the hub), where (the space) and with which space role. Never the sealed copies. */
export function roomResponse(v: {
  hubId: string;
  spaceId: string;
  roleKey: string;
}) {
  return { hubId: v.hubId, spaceId: v.spaceId, roleKey: v.roleKey };
}

export function hubRoleResponse(v: {
  hubId: string;
  userId: string;
  roleKey: string;
}) {
  return { hubId: v.hubId, userId: v.userId, roleKey: v.roleKey };
}
