import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import { byteCount } from '../../../shared/infra/db/byte-count.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { runWithContext } from '../../../shared/infra/db/unit-of-work.js';
import { TRASH_DAYS } from '../../domain/backup-limits.js';
import {
  BackupObjectVersion,
  type BackupUploader,
  type BackupVersionStatus,
} from '../../domain/backup-object-version.js';
import { BackupObjectVersionRepository } from '../../domain/backup-object-version.repository.js';

type VersionRow = {
  id: string;
  organization_id: string;
  space_id: string;
  object_id: string;
  key_version: number;
  size_bytes: string;
  sha256: string;
  status: BackupVersionStatus;
  replaces_version_id: string | null;
  s3_version_id: string | null;
  uploaded_by_hub_id: string | null;
  uploaded_by_user_id: string | null;
  upload_expires_at: Date;
  committed_at: Date | null;
  superseded_at: Date | null;
};

const COLUMNS = `id, organization_id, space_id, object_id, key_version, size_bytes, sha256, status,
  replaces_version_id, s3_version_id, uploaded_by_hub_id, uploaded_by_user_id, upload_expires_at, committed_at,
  superseded_at`;

function toDomain(row: VersionRow): BackupObjectVersion {
  return BackupObjectVersion.restore({
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    objectId: row.object_id,
    keyVersion: row.key_version,
    sizeBytes: byteCount(row.size_bytes),
    sha256: row.sha256,
    status: row.status,
    replacesVersionId: row.replaces_version_id,
    s3VersionId: row.s3_version_id,
    uploader: row.uploaded_by_hub_id
      ? { hubId: row.uploaded_by_hub_id }
      : { userId: row.uploaded_by_user_id! },
    uploadExpiresAt: row.upload_expires_at,
    committedAt: row.committed_at,
    supersededAt: row.superseded_at,
  });
}

function uploaderColumns(
  uploader: BackupUploader,
): [string | null, string | null] {
  return 'hubId' in uploader ? [uploader.hubId, null] : [null, uploader.userId];
}

// Versões dos objetos do backup (storage_object_versions), em SQL, no escopo da organização (RLS). O uso do espaço é
// somado na hora (spec storage-backup §5.3): versões confirmadas atuais ou na lixeira (substituídas há menos de
// 30 dias) mais as reservas das intenções dentro da janela.
@Injectable()
export class BackupObjectVersionTypeormRepository extends BackupObjectVersionRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async create(v: BackupObjectVersion): Promise<void> {
    const [hubId, userId] = uploaderColumns(v.uploader);
    await runInOrganizationScope(this.dataSource, v.organizationId, (m) =>
      m.query(
        `INSERT INTO storage_object_versions
           (id, organization_id, space_id, object_id, key_version, size_bytes, sha256, status, replaces_version_id,
            uploaded_by_hub_id, uploaded_by_user_id, upload_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          v.id,
          v.organizationId,
          v.spaceId,
          v.objectId,
          v.keyVersion,
          String(v.sizeBytes),
          v.sha256,
          v.status,
          v.replacesVersionId,
          hubId,
          userId,
          v.uploadExpiresAt,
        ],
      ),
    );
  }

  async save(v: BackupObjectVersion): Promise<void> {
    await runInOrganizationScope(this.dataSource, v.organizationId, (m) =>
      m.query(
        `UPDATE storage_object_versions
            SET status = $3, s3_version_id = $4, committed_at = $5, updated_at = now()
          WHERE id = $1 AND organization_id = $2`,
        [v.id, v.organizationId, v.status, v.s3VersionId, v.committedAt],
      ),
    );
  }

  async findByIds(
    orgId: string,
    spaceId: string,
    ids: readonly string[],
  ): Promise<BackupObjectVersion[]> {
    const valid = ids.filter((id) => validate(id));
    if (valid.length === 0) return [];
    const rows: VersionRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT ${COLUMNS} FROM storage_object_versions
            WHERE organization_id = $1 AND space_id = $2 AND id = ANY($3::uuid[]) AND deleted_at IS NULL`,
          [orgId, spaceId, valid],
        ),
    );
    return rows.map(toDomain);
  }

  async expirePending(
    orgId: string,
    spaceId: string,
    objectId: string,
    uploader: BackupUploader,
  ): Promise<number> {
    const [hubId, userId] = uploaderColumns(uploader);
    const result: [unknown[], number] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `UPDATE storage_object_versions SET status = 'expired', updated_at = now()
            WHERE organization_id = $1 AND space_id = $2 AND object_id = $3 AND status = 'pending'
              AND uploaded_by_hub_id IS NOT DISTINCT FROM $4::uuid
              AND uploaded_by_user_id IS NOT DISTINCT FROM $5::uuid`,
          [orgId, spaceId, objectId, hubId, userId],
        ),
    );
    return result[1];
  }

  async markSuperseded(
    orgId: string,
    versionIds: readonly string[],
    now: Date,
  ): Promise<void> {
    if (versionIds.length === 0) return;
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `UPDATE storage_object_versions SET superseded_at = $3, updated_at = now()
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND superseded_at IS NULL`,
        [orgId, versionIds, now],
      ),
    );
  }

  async usedBytes(orgId: string, spaceId: string): Promise<number> {
    if (!validate(orgId) || !validate(spaceId)) return 0;
    const rows: { used: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT COALESCE(SUM(size_bytes), 0)::text AS used FROM storage_object_versions
            WHERE organization_id = $1 AND space_id = $2 AND deleted_at IS NULL
              AND ((status = 'committed'
                    AND (superseded_at IS NULL OR superseded_at > now() - make_interval(days => $3)))
                OR (status = 'pending' AND upload_expires_at > now()))`,
          [orgId, spaceId, TRASH_DAYS],
        ),
    );
    return byteCount(rows[0]?.used ?? '0');
  }

  async markVersionsWriteStarted(
    orgId: string,
    spaceId: string,
    versionIds: readonly string[],
    at: Date,
  ): Promise<void> {
    const valid = versionIds.filter((id) => validate(id));
    if (valid.length === 0) return;
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `UPDATE storage_object_versions SET s3_write_started_at = COALESCE(s3_write_started_at, $4)
          WHERE organization_id = $1 AND space_id = $2 AND id = ANY($3::uuid[]) AND status = 'pending'`,
        [orgId, spaceId, valid, at],
      ),
    );
  }

  async markObjectsWriteStarted(
    orgId: string,
    spaceId: string,
    objectIds: readonly string[],
    at: Date,
  ): Promise<void> {
    const valid = objectIds.filter((id) => validate(id));
    if (valid.length === 0) return;
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `UPDATE storage_object_versions SET s3_write_started_at = COALESCE(s3_write_started_at, $4)
          WHERE organization_id = $1 AND space_id = $2 AND object_id = ANY($3::uuid[])
            AND status = 'committed' AND superseded_at IS NULL`,
        [orgId, spaceId, valid, at],
      ),
    );
  }

  async hasWriteMarksBefore(
    orgId: string,
    objectId: string,
    before: Date,
  ): Promise<boolean> {
    const rows: unknown[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT 1 FROM storage_object_versions
            WHERE organization_id = $1 AND object_id = $2 AND s3_write_started_at < $3 LIMIT 1`,
          [orgId, objectId, before],
        ),
    );
    return rows.length > 0;
  }

  async clearVersionMarks(
    orgId: string,
    versionIds: readonly string[],
  ): Promise<void> {
    if (versionIds.length === 0) return;
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `UPDATE storage_object_versions SET s3_write_started_at = NULL
          WHERE organization_id = $1 AND id = ANY($2::uuid[]) AND s3_write_started_at IS NOT NULL`,
        [orgId, versionIds],
      ),
    );
  }

  async clearWriteMarks(
    orgId: string,
    objectId: string,
    before: Date,
  ): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `UPDATE storage_object_versions SET s3_write_started_at = NULL
          WHERE organization_id = $1 AND object_id = $2 AND s3_write_started_at < $3`,
        [orgId, objectId, before],
      ),
    );
  }

  async committedS3VersionIds(
    orgId: string,
    objectId: string,
  ): Promise<string[]> {
    const rows: { s3_version_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT s3_version_id FROM storage_object_versions
            WHERE organization_id = $1 AND object_id = $2 AND status = 'committed'`,
          [orgId, objectId],
        ),
    );
    return rows.map((r) => r.s3_version_id);
  }

  async staleWriteMarks(
    before: Date,
  ): Promise<{ organizationId: string; spaceId: string; objectId: string }[]> {
    // Sem organização no contexto: só a policy storage_reconcile_read (linhas marcadas) deixa ler.
    const rows: {
      organization_id: string;
      space_id: string;
      object_id: string;
    }[] = await runWithContext(
      this.dataSource,
      { storageReconcile: 'on' },
      (m) =>
        m.query(
          `SELECT DISTINCT organization_id, space_id, object_id FROM storage_object_versions
            WHERE s3_write_started_at IS NOT NULL AND s3_write_started_at < $1
            ORDER BY organization_id, object_id`,
          [before],
        ),
    );
    return rows.map((r) => ({
      organizationId: r.organization_id,
      spaceId: r.space_id,
      objectId: r.object_id,
    }));
  }
}
