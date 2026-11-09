import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, type EntityManager } from 'typeorm';
import type { KeysetSlice } from '../../../shared/domain/pagination.js';
import { byteCount } from '../../../shared/infra/db/byte-count.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { TRASH_DAYS } from '../../domain/backup-limits.js';
import {
  BackupIndexReader,
  type ListedObject,
  type ListedVersion,
  type ObjectListing,
  type StoredObjectVersion,
} from '../../application/ports/backup-index-reader.js';

type VersionColumns = {
  version_id: string;
  key_version: number;
  size_bytes: string;
  sha256: string;
  committed_at: Date;
};

type ObjectRow = VersionColumns & {
  object_id: string;
  deleted_at: Date | null;
};

type StoredRow = VersionColumns & {
  object_id: string;
  superseded_at: Date | null;
  current: boolean;
};

function versionOf(r: VersionColumns): ListedVersion {
  return {
    versionId: r.version_id,
    keyVersion: r.key_version,
    sizeBytes: byteCount(r.size_bytes),
    sha256: r.sha256,
    uploadedAt: r.committed_at,
  };
}

/** Not superseded, or superseded inside the 30-day trash window (database clock); `days` is the TRASH_DAYS parameter. */
const inTrashWindow = (column: string, days: string) =>
  `(${column} IS NULL OR ${column} > now() - make_interval(days => ${days}))`;

const VERSION_COLUMNS = `v.id AS version_id, v.key_version, v.size_bytes, v.sha256, v.committed_at`;

async function asOf(m: EntityManager): Promise<Date> {
  const [row]: { as_of: Date }[] = await m.query(`SELECT now() AS as_of`);
  return row!.as_of;
}

// Leituras do índice do backup (spec storage-backup §4.3), em SQL, sem trava, cada uma no escopo da organização (RLS;
// fora de um UnitOfWork.run abre a própria transação, e o `asOf` é o `now()` dela, lido antes da consulta). Só versões
// `committed` com o próprio `s3_version_id`: uma intenção nunca confirmada (objeto criado, sem versão atual) nunca
// aparece. Lixeira = 30 dias no relógio do banco (como o uso do espaço).
@Injectable()
export class BackupIndexSqlReader extends BackupIndexReader {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async listObjects(
    orgId: string,
    spaceId: string,
    listing: ObjectListing,
    slice: KeysetSlice,
  ): Promise<{ rows: ListedObject[]; asOf: Date }> {
    const params: unknown[] = [
      orgId,
      spaceId,
      slice.after ?? null,
      slice.limit + 1,
    ];
    const param = (value: unknown) => `$${params.push(value)}`;
    const filters: string[] = [];
    if (listing.include === 'trash') {
      const days = param(TRASH_DAYS);
      filters.push(
        `o.deleted_at IS NOT NULL`,
        `o.deleted_at > now() - make_interval(days => ${days})`,
        inTrashWindow('v.superseded_at', days),
      );
    } else if (!listing.since) {
      filters.push(`o.deleted_at IS NULL`);
    }
    if (listing.since) {
      // Tombstones included (the `current` listing shows them without a version).
      filters.push(
        `COALESCE(o.updated_at, o.created_at) >= ${param(listing.since)}`,
      );
    }
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const at = await asOf(m);
      const rows: ObjectRow[] = await m.query(
        `SELECT o.id AS object_id, o.deleted_at, ${VERSION_COLUMNS}
           FROM storage_objects o
           JOIN storage_object_versions v
             ON v.id = o.current_version_id AND v.organization_id = o.organization_id
          WHERE o.organization_id = $1 AND o.space_id = $2
            AND v.status = 'committed' AND v.deleted_at IS NULL
            AND ($3::uuid IS NULL OR o.id > $3::uuid)
            ${filters.map((f) => `AND ${f}`).join(' ')}
          ORDER BY o.id
          LIMIT $4`,
        params,
      );
      return {
        asOf: at,
        rows: rows.map((r) => {
          const deleted = r.deleted_at !== null;
          return {
            objectId: r.object_id,
            deleted,
            deletedAt: r.deleted_at,
            // A tombstone in the `current` listing has no current version; the trash shows the last one.
            currentVersion:
              deleted && listing.include === 'current' ? null : versionOf(r),
          };
        }),
      };
    });
  }

  async listVersions(
    orgId: string,
    spaceId: string,
    objectId: string,
    slice: KeysetSlice,
  ): Promise<{ rows: StoredObjectVersion[]; asOf: Date }> {
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      const at = await asOf(m);
      if (!validate(objectId)) return { rows: [], asOf: at };
      const rows: StoredRow[] = await m.query(
        `SELECT v.object_id, ${VERSION_COLUMNS}, v.superseded_at,
                (o.current_version_id = v.id AND o.deleted_at IS NULL) AS current
           FROM storage_object_versions v
           JOIN storage_objects o ON o.id = v.object_id AND o.organization_id = v.organization_id
          WHERE v.organization_id = $1 AND v.space_id = $2 AND o.space_id = $2 AND v.object_id = $3
            AND v.status = 'committed' AND v.deleted_at IS NULL
            AND ${inTrashWindow('v.superseded_at', '$4')}
            AND ($5::uuid IS NULL OR v.id > $5::uuid)
          ORDER BY v.id
          LIMIT $6`,
        [
          orgId,
          spaceId,
          objectId,
          TRASH_DAYS,
          slice.after ?? null,
          slice.limit + 1,
        ],
      );
      return {
        asOf: at,
        rows: rows.map((r) => ({
          ...versionOf(r),
          objectId: r.object_id,
          supersededAt: r.superseded_at,
          current: r.current,
        })),
      };
    });
  }

  async downloadableS3VersionId(
    orgId: string,
    spaceId: string,
    objectId: string,
    versionId: string,
  ): Promise<string | null> {
    if (!validate(objectId) || !validate(versionId)) return null;
    const rows: { s3_version_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT v.s3_version_id FROM storage_object_versions v
            WHERE v.organization_id = $1 AND v.space_id = $2 AND v.object_id = $3 AND v.id = $4
              AND v.status = 'committed' AND v.s3_version_id IS NOT NULL AND v.deleted_at IS NULL
              AND ${inTrashWindow('v.superseded_at', '$5')}`,
          [orgId, spaceId, objectId, versionId, TRASH_DAYS],
        ),
    );
    return rows[0]?.s3_version_id ?? null;
  }
}
