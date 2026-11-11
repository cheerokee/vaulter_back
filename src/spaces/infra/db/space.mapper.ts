import { byteCount } from '../../../shared/infra/db/byte-count.js';
import { Space } from '../../domain/space.js';
import type { SpaceTypeormEntity } from './space.entity.js';

/** Raw row of `SELECT s.* FROM spaces s` (snake_case, as the pg driver returns it). */
export type SpaceRow = {
  id: string;
  organization_id: string;
  name: string;
  current_key_version: number;
  key_rotation_required: boolean;
  storage_quota_bytes: string;
  cloud_mode: 'encrypted_backup' | 'active_cloud';
  cloud_activated_at: Date | null;
  allow_online_llm: boolean;
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
        storageQuotaBytes: byteCount(row.storageQuotaBytes),
        cloudMode: row.cloudMode,
        cloudActivatedAt: row.cloudActivatedAt,
        allowOnlineLlm: row.allowOnlineLlm,
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
        storageQuotaBytes: byteCount(row.storage_quota_bytes),
        cloudMode: row.cloud_mode,
        cloudActivatedAt: row.cloud_activated_at,
        allowOnlineLlm: row.allow_online_llm,
        createdAt: row.created_at,
        updatedAt: row.updated_at ?? undefined,
      },
      row.id,
    );
  },

  // createdAt vem do domínio (explícito no insert); updatedAt e syncVersion ficam com o banco. cloud_mode,
  // cloud_activated_at e allow_online_llm nunca saem daqui (o `save` não os regrava): cloud_mode/cloud_activated_at só
  // mudam por `SpaceRepository.setCloudMode` (fluxo do módulo `cloud`); allow_online_llm fica com o default (v1).
  toPersistence(space: Space): Partial<SpaceTypeormEntity> {
    return {
      id: space.id,
      createdAt: space.createdAt,
      organizationId: space.organizationId,
      name: space.name,
      currentKeyVersion: space.currentKeyVersion,
      keyRotationRequired: space.keyRotationRequired,
      storageQuotaBytes: String(space.storageQuotaBytes),
    };
  },
};
