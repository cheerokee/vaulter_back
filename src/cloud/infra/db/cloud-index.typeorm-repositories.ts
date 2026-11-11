import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { CloudFile } from '../../domain/cloud-file.js';
import {
  type ChunkHit,
  CloudChunkRepository,
  CloudFileRepository,
  type NewChunk,
} from '../../domain/indexing.repositories.js';
import { CloudFileTypeormEntity } from './cloud-file.entity.js';

/** Rows per page when listing the files of a space. */
const LIST_PAGE = 1000;

function requireUnitOfWork(dataSource: DataSource, method: string): void {
  if (!currentManager(dataSource).queryRunner?.isTransactionActive) {
    throw new Error(
      `${method} requires an active unit of work (call it inside UnitOfWork.run).`,
    );
  }
}

const toFile = (r: CloudFileTypeormEntity): CloudFile => ({
  id: r.id,
  organizationId: r.organizationId,
  spaceId: r.spaceId,
  fileId: r.fileId,
  manifest: r.manifest,
  name: r.name,
  path: r.path,
  mediaType: r.mediaType,
  source:
    r.sourceKind === 'connector'
      ? { kind: 'connector', connector: r.connector ?? '' }
      : { kind: r.sourceKind },
  modifiedAt: r.modifiedAt,
  parts: r.partObjectIds.map((objectId, i) => ({
    objectId,
    versionId: r.partVersionIds[i]!,
  })),
  status: r.status,
  skipReason: r.skipReason,
  embeddingModel: r.embeddingModel,
  chunkCount: r.chunkCount,
  indexedAt: r.indexedAt,
});

const toRow = (f: CloudFile): Partial<CloudFileTypeormEntity> => ({
  id: f.id,
  organizationId: f.organizationId,
  spaceId: f.spaceId,
  fileId: f.fileId,
  manifest: f.manifest,
  name: f.name,
  path: f.path,
  mediaType: f.mediaType,
  sourceKind: f.source.kind,
  connector: f.source.kind === 'connector' ? f.source.connector : null,
  modifiedAt: f.modifiedAt,
  partObjectIds: f.parts.map((p) => p.objectId),
  partVersionIds: f.parts.map((p) => p.versionId),
  status: f.status,
  skipReason: f.skipReason,
  embeddingModel: f.embeddingModel,
  chunkCount: f.chunkCount,
  indexedAt: f.indexedAt,
});

@Injectable()
export class CloudFileTypeormRepository extends CloudFileRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async findById(orgId: string, id: string): Promise<CloudFile | null> {
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m
        .getRepository(CloudFileTypeormEntity)
        .findOne({ where: { organizationId: orgId, id } }),
    );
    return row ? toFile(row) : null;
  }

  async listForSpace(orgId: string, spaceId: string): Promise<CloudFile[]> {
    const out: CloudFile[] = [];
    let after: string | null = null;
    for (;;) {
      const page = await runInOrganizationScope(this.dataSource, orgId, (m) =>
        m
          .getRepository(CloudFileTypeormEntity)
          .createQueryBuilder('f')
          .where('f.organization_id = :orgId AND f.space_id = :spaceId', {
            orgId,
            spaceId,
          })
          .andWhere(after ? 'f.id > :after' : '1 = 1', { after })
          .orderBy('f.id', 'ASC')
          .take(LIST_PAGE)
          .getMany(),
      );
      out.push(...page.map(toFile));
      if (page.length < LIST_PAGE) return out;
      after = page[page.length - 1]!.id;
    }
  }

  async lockByFileIds(
    orgId: string,
    spaceId: string,
    fileIds: readonly string[],
  ): Promise<CloudFile[]> {
    requireUnitOfWork(this.dataSource, 'CloudFileRepository.lockByFileIds');
    if (fileIds.length === 0) return [];
    const rows = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(CloudFileTypeormEntity).find({
        where: { organizationId: orgId, spaceId, fileId: In([...fileIds]) },
        order: { id: 'ASC' },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    return rows.map(toFile);
  }

  async lockById(orgId: string, id: string): Promise<CloudFile | null> {
    requireUnitOfWork(this.dataSource, 'CloudFileRepository.lockById');
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(CloudFileTypeormEntity).findOne({
        where: { organizationId: orgId, id },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    return row ? toFile(row) : null;
  }

  async upsert(file: CloudFile): Promise<void> {
    await runInOrganizationScope(this.dataSource, file.organizationId, (m) =>
      m
        .getRepository(CloudFileTypeormEntity)
        .upsert(toRow(file), { conflictPaths: ['id'] }),
    );
  }

  async upsertMany(files: readonly CloudFile[]): Promise<Map<string, string>> {
    const first = files[0];
    if (!first) return new Map();
    const records = files.map((f) => ({
      id: f.id,
      organization_id: f.organizationId,
      space_id: f.spaceId,
      file_id: f.fileId,
      manifest: f.manifest,
      name: f.name,
      path: f.path,
      media_type: f.mediaType,
      source_kind: f.source.kind,
      connector: f.source.kind === 'connector' ? f.source.connector : null,
      modified_at: f.modifiedAt?.toISOString() ?? null,
      part_object_ids: f.parts.map((p) => p.objectId),
      part_version_ids: f.parts.map((p) => p.versionId),
      status: f.status,
      skip_reason: f.skipReason,
      embedding_model: f.embeddingModel,
      chunk_count: f.chunkCount,
      indexed_at: f.indexedAt?.toISOString() ?? null,
    }));
    const rows: { id: string; file_id: string }[] =
      await runInOrganizationScope(this.dataSource, first.organizationId, (m) =>
        m.query(
          `INSERT INTO cloud_files
             (id, organization_id, space_id, file_id, manifest, name, path, media_type, source_kind, connector,
              modified_at, part_object_ids, part_version_ids, status, skip_reason, embedding_model, chunk_count,
              indexed_at)
           SELECT id, organization_id, space_id, file_id, manifest, name, path, media_type, source_kind, connector,
                  modified_at, part_object_ids, part_version_ids, status, skip_reason, embedding_model, chunk_count,
                  indexed_at
             FROM jsonb_to_recordset($1::jsonb) AS r(
               id uuid, organization_id uuid, space_id uuid, file_id uuid, manifest varchar, name varchar,
               path varchar, media_type varchar, source_kind varchar, connector varchar, modified_at timestamptz,
               part_object_ids uuid[], part_version_ids uuid[], status varchar, skip_reason varchar,
               embedding_model varchar, chunk_count integer, indexed_at timestamptz)
           ON CONFLICT (space_id, file_id) DO UPDATE SET
             manifest = EXCLUDED.manifest, name = EXCLUDED.name, path = EXCLUDED.path,
             media_type = EXCLUDED.media_type, source_kind = EXCLUDED.source_kind, connector = EXCLUDED.connector,
             modified_at = EXCLUDED.modified_at, part_object_ids = EXCLUDED.part_object_ids,
             part_version_ids = EXCLUDED.part_version_ids, status = EXCLUDED.status,
             skip_reason = EXCLUDED.skip_reason, embedding_model = EXCLUDED.embedding_model,
             chunk_count = EXCLUDED.chunk_count, indexed_at = EXCLUDED.indexed_at, updated_at = now()
           RETURNING id, file_id`,
          [JSON.stringify(records)],
        ),
      );
    return new Map(rows.map((r) => [r.file_id, r.id]));
  }

  async deleteByIds(orgId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m
        .getRepository(CloudFileTypeormEntity)
        .delete({ organizationId: orgId, id: In([...ids]) }),
    );
  }

  async spacesWithPending(orgId: string): Promise<string[]> {
    const rows: { space_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT DISTINCT space_id FROM cloud_files
            WHERE organization_id = $1 AND status = 'pending'
            ORDER BY space_id`,
          [orgId],
        ),
    );
    return rows.map((r) => r.space_id);
  }

  async deleteForSpace(orgId: string, spaceId: string): Promise<number> {
    const result = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m
        .getRepository(CloudFileTypeormEntity)
        .delete({ organizationId: orgId, spaceId }),
    );
    return result.affected ?? 0;
  }
}

/** Rows per INSERT of chunks (each row carries a 768-float vector as text: ~10 kB). */
const CHUNK_INSERT_BATCH = 100;

// Os trechos em SQL: o vetor vai como texto `[x,y,...]::vector` (o pgvector converte).
@Injectable()
export class CloudChunkSqlRepository extends CloudChunkRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async replaceForFile(
    file: CloudFile,
    model: string,
    chunks: readonly NewChunk[],
  ): Promise<void> {
    const first = file.parts[0];
    if (!first) throw new Error('replaceForFile: a file without parts');
    await runInOrganizationScope(
      this.dataSource,
      file.organizationId,
      async (m) => {
        await m.query(
          `DELETE FROM cloud_chunks WHERE organization_id = $1 AND cloud_file_id = $2`,
          [file.organizationId, file.id],
        );
        for (let i = 0; i < chunks.length; i += CHUNK_INSERT_BATCH) {
          const batch = chunks.slice(i, i + CHUNK_INSERT_BATCH);
          const params: unknown[] = [
            file.organizationId,
            file.spaceId,
            file.id,
            file.fileId,
            first.objectId,
            first.versionId,
            model,
          ];
          const values = batch.map((c) => {
            params.push(c.position, c.text, `[${c.embedding.join(',')}]`);
            const n = params.length;
            return `($1, $2, $3, $4, $5, $6, $${n - 2}, $${n - 1}, $${n}::vector, $7)`;
          });
          await m.query(
            `INSERT INTO cloud_chunks
               (organization_id, space_id, cloud_file_id, file_id, object_id, version_id, position, text, embedding,
                embedding_model)
             VALUES ${values.join(', ')}`,
            params,
          );
        }
      },
    );
  }

  async deleteForFile(orgId: string, cloudFileId: string): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `DELETE FROM cloud_chunks WHERE organization_id = $1 AND cloud_file_id = $2`,
        [orgId, cloudFileId],
      ),
    );
  }

  async deleteForFiles(
    orgId: string,
    cloudFileIds: readonly string[],
  ): Promise<void> {
    if (cloudFileIds.length === 0) return;
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `DELETE FROM cloud_chunks WHERE organization_id = $1 AND cloud_file_id = ANY($2::uuid[])`,
        [orgId, [...cloudFileIds]],
      ),
    );
  }

  async deleteForSpace(orgId: string, spaceId: string): Promise<number> {
    return runInOrganizationScope(this.dataSource, orgId, async (m) => {
      // A SELECT around the DELETE: TypeORM returns [rows, count] for a bare DELETE.
      const [row]: { count: number }[] = await m.query(
        `WITH deleted AS (
           DELETE FROM cloud_chunks WHERE organization_id = $1 AND space_id = $2 RETURNING 1
         )
         SELECT count(*)::int AS count FROM deleted`,
        [orgId, spaceId],
      );
      return row!.count;
    });
  }

  async search(
    orgId: string,
    spaceId: string,
    embedding: readonly number[],
    model: string,
    limit: number,
  ): Promise<ChunkHit[]> {
    const rows: {
      file_id: string;
      name: string;
      path: string | null;
      position: number;
      text: string;
      distance: number;
    }[] = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `SELECT c.file_id, f.name, f.path, c.position, c.text,
                (c.embedding <=> $3::vector)::float8 AS distance
           FROM cloud_chunks c
           JOIN cloud_files f ON f.id = c.cloud_file_id AND f.organization_id = c.organization_id
          WHERE c.organization_id = $1 AND c.space_id = $2 AND c.embedding_model = $4
          ORDER BY c.embedding <=> $3::vector
          LIMIT $5`,
        [orgId, spaceId, `[${embedding.join(',')}]`, model, limit],
      ),
    );
    return rows.map((r) => ({
      fileId: r.file_id,
      name: r.name,
      path: r.path,
      position: r.position,
      text: r.text,
      distance: Number(r.distance),
    }));
  }
}
