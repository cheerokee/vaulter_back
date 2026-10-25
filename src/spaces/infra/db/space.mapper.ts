import { Space } from '../../domain/space.js';
import type { SpaceTypeormEntity } from './space.entity.js';

/** Raw row of `SELECT s.* FROM spaces s` (snake_case, as the pg driver returns it). */
export type SpaceRow = {
  id: string;
  organization_id: string;
  name: string;
  current_key_version: number;
  key_rotation_required: boolean;
  created_at: Date;
  updated_at: Date | null;
};

export const SpaceMapper = {
  toDomain(row: SpaceTypeormEntity): Space {
    return Space.restore(
      {
        organizationId: row.organizationId,
        name: row.name,
        currentKeyVersion: row.currentKeyVersion,
        keyRotationRequired: row.keyRotationRequired,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt ?? undefined,
      },
      row.id,
    );
  },

  fromRow(row: SpaceRow): Space {
    return Space.restore(
      {
        organizationId: row.organization_id,
        name: row.name,
        currentKeyVersion: row.current_key_version,
        keyRotationRequired: row.key_rotation_required,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? undefined,
      },
      row.id,
    );
  },

  // createdAt vem do domínio (explícito no insert); updatedAt e syncVersion ficam com o banco. cloud_mode e
  // allow_online_llm ficam com os defaults (v1).
  toPersistence(space: Space): Partial<SpaceTypeormEntity> {
    return {
      id: space.id,
      createdAt: space.createdAt,
      organizationId: space.organizationId,
      name: space.name,
      currentKeyVersion: space.currentKeyVersion,
      keyRotationRequired: space.keyRotationRequired,
    };
  },
};
