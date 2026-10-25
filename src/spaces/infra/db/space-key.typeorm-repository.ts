import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  SpaceKeyRepository,
  type SpaceKeyVersion,
} from '../../domain/space-key.repository.js';
import { spaceKeyNotFound, spaceNotFound, updatedRows } from './db-helpers.js';

type KeyRow = {
  id: string;
  space_id: string;
  version: number;
  recovery_wrapped_key: string;
  recovery_key_fingerprint: string;
};

const COLUMNS = `id, space_id, version, recovery_wrapped_key, recovery_key_fingerprint`;

@Injectable()
export class SpaceKeyTypeormRepository extends SpaceKeyRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // organization_id vem do espaço (que precisa ser da organização do contexto): uma versão nunca fica
  // pendurada num espaço de outra organização.
  async addVersion(
    orgId: string,
    spaceId: string,
    version: number,
    recoveryWrappedKey: string,
    fingerprint: string,
  ): Promise<SpaceKeyVersion> {
    const rows: KeyRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `INSERT INTO space_keys (organization_id, space_id, version, recovery_wrapped_key, recovery_key_fingerprint)
           SELECT s.organization_id, s.id, $3, $4, $5
             FROM spaces s
            WHERE s.id = $2 AND s.organization_id = $1 AND s.deleted_at IS NULL
           RETURNING ${COLUMNS}`,
          [orgId, spaceId, version, recoveryWrappedKey, fingerprint],
        ),
    );
    const row = rows[0];
    if (!row) {
      throw spaceNotFound();
    }
    return toVersion(row);
  }

  async versions(orgId: string, spaceId: string): Promise<SpaceKeyVersion[]> {
    const rows: KeyRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT ${COLUMNS} FROM space_keys
            WHERE organization_id = $1 AND space_id = $2 AND deleted_at IS NULL
            ORDER BY version ASC`,
          [orgId, spaceId],
        ),
    );
    return rows.map(toVersion);
  }

  // Retrancar sobrescreve a coluna; o trigger sobe o sync_version e os hubs recebem a cópia nova.
  async setRecoveryWrap(
    orgId: string,
    spaceId: string,
    version: number,
    wrappedKey: string,
    fingerprint: string,
  ): Promise<void> {
    const raw: unknown = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE space_keys
              SET recovery_wrapped_key = $4, recovery_key_fingerprint = $5, updated_at = now()
            WHERE organization_id = $1 AND space_id = $2 AND version = $3 AND deleted_at IS NULL
           RETURNING id`,
          [orgId, spaceId, version, wrappedKey, fingerprint],
        ),
    );
    if (updatedRows(raw).length === 0) {
      throw spaceKeyNotFound();
    }
  }
}

function toVersion(row: KeyRow): SpaceKeyVersion {
  return {
    id: row.id,
    spaceId: row.space_id,
    version: row.version,
    recoveryWrappedKey: row.recovery_wrapped_key,
    recoveryKeyFingerprint: row.recovery_key_fingerprint,
  };
}
