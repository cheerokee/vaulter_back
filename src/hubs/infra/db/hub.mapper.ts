import { Hub } from '../../domain/hub.js';
import type { HubTypeormEntity } from './hub.entity.js';

/** Raw row of `SELECT h.* FROM hubs h` (snake_case, as the pg driver returns it). */
export type HubRow = {
  id: string;
  owner_user_id: string;
  name: string;
  signing_public_key: string;
  encryption_public_key: string;
  last_seen_at: Date | null;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date | null;
};

export const HubMapper = {
  toDomain(row: HubTypeormEntity): Hub {
    return Hub.restore(
      {
        ownerUserId: row.ownerUserId,
        name: row.name,
        signingPublicKey: row.signingPublicKey,
        encryptionPublicKey: row.encryptionPublicKey,
        lastSeenAt: row.lastSeenAt,
        deletedAt: row.deletedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt ?? undefined,
      },
      row.id,
    );
  },

  fromRow(row: HubRow): Hub {
    return Hub.restore(
      {
        ownerUserId: row.owner_user_id,
        name: row.name,
        signingPublicKey: row.signing_public_key,
        encryptionPublicKey: row.encryption_public_key,
        lastSeenAt: row.last_seen_at,
        deletedAt: row.deleted_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? undefined,
      },
      row.id,
    );
  },

  // createdAt vem do domínio (explícito no insert); updatedAt e syncVersion ficam com o banco.
  toPersistence(hub: Hub): Partial<HubTypeormEntity> {
    return {
      id: hub.id,
      createdAt: hub.createdAt,
      ownerUserId: hub.ownerUserId,
      name: hub.name,
      signingPublicKey: hub.signingPublicKey,
      encryptionPublicKey: hub.encryptionPublicKey,
      lastSeenAt: hub.lastSeenAt,
      deletedAt: hub.deletedAt,
    };
  },
};
