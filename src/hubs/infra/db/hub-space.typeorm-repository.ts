import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, MoreThan } from 'typeorm';
import type { KeysetSlice } from '../../../shared/domain/pagination.js';
import { byteCount } from '../../../shared/infra/db/byte-count.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  currentManager,
  runWithContext,
} from '../../../shared/infra/db/unit-of-work.js';
import {
  HubSpaceRepository,
  type HubSpaceRef,
} from '../../domain/hub-space.repository.js';
import {
  hubNotFound,
  requireUnitOfWork,
  spaceNotFound,
  updatedRows,
} from './db-helpers.js';
import { HubSpaceTypeormEntity } from './hub-space.entity.js';

// Escrita sempre no escopo da organização do espaço (org_isolation é a única policy de escrita; a FK composta
// (space_id, organization_id) garante que o espaço é dessa organização, e a (hub_id, organization_id) que há
// vínculo). Leitura no contexto ambiente: org_isolation, dono do Hub ou o próprio Hub (só com vínculo aprovado).
// Um Gestor que não é dono age com o escopo da organização (`app.organization_id`). Linhas com lápide ficam fora.
function toRef(r: HubSpaceTypeormEntity): HubSpaceRef {
  return {
    hubId: r.hubId,
    spaceId: r.spaceId,
    organizationId: r.organizationId,
    addedByUserId: r.addedByUserId,
  };
}

const spaceAfter = (slice?: KeysetSlice) =>
  slice?.after ? { spaceId: MoreThan(slice.after) } : {};

@Injectable()
export class HubSpaceTypeormRepository extends HubSpaceRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Idempotente: uma linha ativa fica como está (com quem a pôs); uma lápide é revivida com quem pôs agora.
  async add(ref: HubSpaceRef): Promise<void> {
    await runInOrganizationScope(
      this.dataSource,
      ref.organizationId,
      async (m) => {
        const space: unknown[] = await m.query(
          `SELECT 1 FROM spaces WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
          [ref.spaceId, ref.organizationId],
        );
        if (space.length === 0) throw spaceNotFound();
        const link: unknown[] = await m.query(
          `SELECT 1 FROM hub_organization
            WHERE hub_id = $1 AND organization_id = $2 AND status = 'approved' AND deleted_at IS NULL`,
          [ref.hubId, ref.organizationId],
        );
        if (link.length === 0) throw hubNotFound();
        await m.query(
          `INSERT INTO hub_space (hub_id, space_id, organization_id, added_by_user_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (hub_id, space_id) DO UPDATE
             SET deleted_at = NULL, added_by_user_id = EXCLUDED.added_by_user_id, updated_at = now()
           WHERE hub_space.deleted_at IS NOT NULL`,
          [ref.hubId, ref.spaceId, ref.organizationId, ref.addedByUserId],
        );
      },
    );
  }

  // Lápide no escopo da organização (org_isolation): também a via do Gestor que não é dono do Hub.
  async remove(
    hubId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<boolean> {
    if (![hubId, spaceId, organizationId].every((id) => validate(id))) {
      return false;
    }
    const rows = updatedRows<{ space_id: string }>(
      await runInOrganizationScope(this.dataSource, organizationId, (m) =>
        m.query(
          `UPDATE hub_space SET deleted_at = now(), updated_at = now()
            WHERE hub_id = $1 AND space_id = $2 AND organization_id = $3 AND deleted_at IS NULL
           RETURNING space_id`,
          [hubId, spaceId, organizationId],
        ),
      ),
    );
    return rows.length > 0;
  }

  async removeAllOfOrganization(
    hubId: string,
    organizationId: string,
  ): Promise<string[]> {
    if (!validate(hubId) || !validate(organizationId)) return [];
    const rows = updatedRows<{ space_id: string }>(
      await runInOrganizationScope(this.dataSource, organizationId, (m) =>
        m.query(
          `UPDATE hub_space SET deleted_at = now(), updated_at = now()
            WHERE hub_id = $1 AND organization_id = $2 AND deleted_at IS NULL
           RETURNING space_id`,
          [hubId, organizationId],
        ),
      ),
    );
    return rows.map((r) => r.space_id).sort();
  }

  async find(hubId: string, spaceId: string): Promise<HubSpaceRef | null> {
    if (!validate(hubId) || !validate(spaceId)) return null;
    const row = await currentManager(this.dataSource)
      .getRepository(HubSpaceTypeormEntity)
      .findOne({ where: { hubId, spaceId } });
    return row ? toRef(row) : null;
  }

  // FOR SHARE exige a policy de UPDATE (org_isolation): no escopo da organização.
  async lockForShare(
    hubId: string,
    spaceId: string,
    organizationId: string,
  ): Promise<HubSpaceRef | null> {
    requireUnitOfWork(this.dataSource, 'HubSpaceRepository.lockForShare');
    if (![hubId, spaceId, organizationId].every((id) => validate(id))) {
      return null;
    }
    const row = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(HubSpaceTypeormEntity).findOne({
          where: { hubId, spaceId, organizationId },
          lock: { mode: 'pessimistic_read' },
        }),
    );
    return row ? toRef(row) : null;
  }

  async lockAllOfOrganization(
    hubId: string,
    organizationId: string,
  ): Promise<string[]> {
    requireUnitOfWork(
      this.dataSource,
      'HubSpaceRepository.lockAllOfOrganization',
    );
    if (!validate(hubId) || !validate(organizationId)) return [];
    const rows: { space_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.query(
          `SELECT space_id FROM hub_space
            WHERE hub_id = $1 AND organization_id = $2 AND deleted_at IS NULL
            ORDER BY space_id
              FOR UPDATE`,
          [hubId, organizationId],
        ),
    );
    return rows.map((r) => r.space_id);
  }

  async listInOrganization(
    hubId: string,
    organizationId: string,
    slice?: KeysetSlice,
  ): Promise<HubSpaceRef[]> {
    if (!validate(hubId) || !validate(organizationId)) return [];
    const rows = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(HubSpaceTypeormEntity).find({
          where: { hubId, organizationId, ...spaceAfter(slice) },
          order: { spaceId: 'ASC' },
          ...(slice ? { take: slice.limit } : {}),
        }),
    );
    return rows.map(toRef);
  }

  async list(hubId: string, slice?: KeysetSlice): Promise<HubSpaceRef[]> {
    if (!validate(hubId)) return [];
    const rows = await currentManager(this.dataSource)
      .getRepository(HubSpaceTypeormEntity)
      .find({
        where: { hubId, ...spaceAfter(slice) },
        order: { spaceId: 'ASC' },
        ...(slice ? { take: slice.limit } : {}),
      });
    return rows.map(toRef);
  }

  async hubIdsOfSpace(
    organizationId: string,
    spaceId: string,
  ): Promise<string[]> {
    if (!validate(organizationId) || !validate(spaceId)) return [];
    const rows: { hub_id: string }[] = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.query(
          `SELECT hub_id FROM hub_space
            WHERE space_id = $1 AND organization_id = $2 AND deleted_at IS NULL
            ORDER BY hub_id`,
          [spaceId, organizationId],
        ),
    );
    return rows.map((r) => r.hub_id);
  }

  // Atravessa organizações: a lista vem de hub_organization no contexto do próprio Hub (ele lê todos os próprios
  // vínculos, com lápides: um espaço só fica no Hub com vínculo, mas a lista inteira é barata e não depende do status),
  // e cada organização é somada no próprio escopo (hub_space e spaces por org_isolation). Lê `spaces.storage_quota_bytes`
  // em SQL, como `add` já lê `spaces` (o tamanho é do `spaces`; mudou a coluna lá, atualize aqui).
  async reservedBytes(
    hubId: string,
    organizationIds?: readonly string[],
  ): Promise<number> {
    if (!validate(hubId)) return 0;
    const orgIds =
      organizationIds ??
      (
        await runWithContext(
          this.dataSource,
          { hubId },
          (m) =>
            m.query(
              `SELECT DISTINCT organization_id FROM hub_organization WHERE hub_id = $1 ORDER BY organization_id`,
              [hubId],
            ) as Promise<{ organization_id: string }[]>,
        )
      ).map((r) => r.organization_id);
    let total = 0;
    for (const orgId of new Set(orgIds)) {
      if (!validate(orgId)) continue;
      const rows: { reserved: string }[] = await runInOrganizationScope(
        this.dataSource,
        orgId,
        (m) =>
          m.query(
            `SELECT COALESCE(SUM(s.storage_quota_bytes), 0)::bigint AS reserved
               FROM hub_space hs
               JOIN spaces s ON s.id = hs.space_id AND s.organization_id = hs.organization_id
              WHERE hs.hub_id = $1 AND hs.organization_id = $2
                AND hs.deleted_at IS NULL AND s.deleted_at IS NULL`,
            [hubId, orgId],
          ),
      );
      total += byteCount(rows[0]?.reserved ?? '0');
    }
    return total;
  }
}
