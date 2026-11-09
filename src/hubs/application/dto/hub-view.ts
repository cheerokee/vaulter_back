import type { Hub } from '../../domain/hub.js';
import type { HubRole } from '../hub-access.js';

export type HubView = {
  id: string;
  name: string;
  ownerUserId: string;
  encryptionPublicKey: string;
  lastSeenAt: Date | null;
  createdAt: Date | null;
};

export function toHubView(hub: Hub): HubView {
  return {
    id: hub.id,
    name: hub.name,
    ownerUserId: hub.ownerUserId,
    encryptionPublicKey: hub.encryptionPublicKey,
    lastSeenAt: hub.lastSeenAt,
    createdAt: hub.createdAt ?? null,
  };
}

/** Capacity the hub reported (null = never) and the reserved size of the installed spaces the viewer may see. */
export type HubStorageView = {
  capacityBytes: number | null;
  reservedBytes: number;
};

/** The hub as seen by one user: their role on it (spec §6; `hub_user` is implicit for linked members). */
export type HubWithRoleView = HubView & {
  role: HubRole;
  /** Only on `GET /hubs/:id`. */
  storage?: HubStorageView;
};

export function toHubWithRoleView(hub: Hub, role: HubRole): HubWithRoleView {
  return { ...toHubView(hub), role };
}
