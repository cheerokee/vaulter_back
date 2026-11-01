import type { Hub } from '../../domain/hub.js';

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
