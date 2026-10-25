import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import {
  decodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import type { Space } from '../../domain/space.js';
import type { SpaceRoleKey } from '../../domain/space-membership.js';
import {
  SpaceRepository,
  type SpaceListItem,
  type SpaceSummary,
} from '../../domain/space.repository.js';
import { requireUnitOfWork, toCursorPage } from './db-helpers.js';
import { SpaceTypeormEntity } from './space.entity.js';
import { SpaceMapper, type SpaceRow } from './space.mapper.js';

type MemberSpaceRow = SpaceRow & {
  role_key: SpaceRoleKey;
  recovery_rewrap_required: boolean;
  pending_grants: number;
};

// Todo método roda na transação ambiente (ou na própria) com `app.organization_id` = orgId e ainda filtra
// por organization_id (primeira trava; o RLS é a segunda). Ordem por id (v7 = ordem de criação).
@Injectable()
export class SpaceTypeormRepository extends SpaceRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async create(space: Space): Promise<void> {
    await runInOrganizationScope(this.dataSource, space.organizationId, (m) =>
      m
        .getRepository(SpaceTypeormEntity)
        .insert(SpaceMapper.toPersistence(space)),
    );
  }

  async save(space: Space): Promise<void> {
    const {
      id,
      createdAt: _createdAt,
      organizationId,
      ...rest
    } = SpaceMapper.toPersistence(space);
    await runInOrganizationScope(this.dataSource, space.organizationId, (m) =>
      m
        .getRepository(SpaceTypeormEntity)
        .update({ id: id!, organizationId: organizationId! }, rest),
    );
  }

  async findById(orgId: string, spaceId: string): Promise<Space | null> {
    if (!validate(spaceId)) return null;
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m
        .getRepository(SpaceTypeormEntity)
        .findOne({ where: { id: spaceId, organizationId: orgId } }),
    );
    return row ? SpaceMapper.toDomain(row) : null;
  }

  // O lock passa do savepoint do contexto para a transação de fora e vale até o fim do UnitOfWork.run.
  async lockForUpdate(orgId: string, spaceId: string): Promise<Space | null> {
    requireUnitOfWork(this.dataSource, 'SpaceRepository.lockForUpdate');
    if (!validate(spaceId)) return null;
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(SpaceTypeormEntity).findOne({
        where: { id: spaceId, organizationId: orgId },
        lock: { mode: 'pessimistic_write' },
      }),
    );
    return row ? SpaceMapper.toDomain(row) : null;
  }

  // Uma consulta: papel, "retrancar pendente" (alguma versão ativa com impressão diferente da do kit atual;
  // sem kit, false) e a contagem de pendências abertas (o caso de uso mostra só para Gestor).
  async listForMember(
    orgId: string,
    userId: string,
    currentKitFingerprint: string | null,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceListItem>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows: MemberSpaceRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT s.*, r.key AS role_key,
                  ($3::text IS NOT NULL AND EXISTS (
                    SELECT 1 FROM space_keys k
                     WHERE k.space_id = s.id AND k.organization_id = s.organization_id
                       AND k.deleted_at IS NULL AND k.recovery_key_fingerprint <> $3::text
                  )) AS recovery_rewrap_required,
                  (SELECT count(*)::int FROM space_pending_grants pg
                    WHERE pg.space_id = s.id AND pg.organization_id = s.organization_id
                      AND pg.status = 'pending' AND pg.deleted_at IS NULL) AS pending_grants
             FROM spaces s
             JOIN role_assignments ra
               ON ra.space_id = s.id AND ra.organization_id = s.organization_id
              AND ra.scope_type = 'space' AND ra.user_id = $2 AND ra.deleted_at IS NULL
             JOIN roles r ON r.id = ra.role_id
            WHERE s.organization_id = $1 AND s.deleted_at IS NULL
              AND ($4::uuid IS NULL OR s.id > $4::uuid)
            ORDER BY s.id ASC
            LIMIT $5`,
          [orgId, userId, currentKitFingerprint, cursor, page.limit + 1],
        ),
    );
    const items = rows.slice(0, page.limit).map((row) => {
      const space = SpaceMapper.fromRow(row);
      return {
        space,
        roleKey: row.role_key,
        keyRotationRequired: space.keyRotationRequired,
        recoveryRewrapRequired: row.recovery_rewrap_required,
        pendingGrants: row.pending_grants,
      };
    });
    return toCursorPage(items, rows.length > page.limit, (i) => i.space.id);
  }

  async listAll(
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<SpaceSummary>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows: (SpaceRow & { member_count: number })[] =
      await runInOrganizationScope(this.dataSource, orgId, (m) =>
        m.query(
          `SELECT s.*,
                  (SELECT count(*)::int FROM role_assignments ra
                    WHERE ra.space_id = s.id AND ra.organization_id = s.organization_id
                      AND ra.scope_type = 'space' AND ra.deleted_at IS NULL) AS member_count
             FROM spaces s
            WHERE s.organization_id = $1 AND s.deleted_at IS NULL
              AND ($2::uuid IS NULL OR s.id > $2::uuid)
            ORDER BY s.id ASC
            LIMIT $3`,
          [orgId, cursor, page.limit + 1],
        ),
      );
    const items = rows.slice(0, page.limit).map((row) => ({
      space: SpaceMapper.fromRow(row),
      memberCount: row.member_count,
    }));
    return toCursorPage(items, rows.length > page.limit, (i) => i.space.id);
  }
}
