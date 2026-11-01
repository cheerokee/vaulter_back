import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import {
  HubSpaceRepository,
  type HubSpaceRef,
} from '../../domain/hub-space.repository.js';
import { hubNotFound, spaceNotFound } from './db-helpers.js';
import { HubSpaceTypeormEntity } from './hub-space.entity.js';

// Escrita sempre no escopo da organização do espaço (org_isolation é a única policy de escrita; a FK composta
// (space_id, organization_id) garante que o espaço é dessa organização, e a (hub_id, organization_id) que há
// vínculo). Leitura no contexto ambiente: org_isolation, dono do Hub ou o próprio Hub (só com vínculo aprovado).
// Um Gestor que não é dono age com o escopo da organização (`app.organization_id`). Linhas com lápide ficam fora.
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

  // Acha a linha ativa no contexto ambiente e grava a lápide no escopo da organização dela. Invisível = no-op.
  async remove(hubId: string, spaceId: string): Promise<void> {
    if (!validate(hubId) || !validate(spaceId)) return;
    const row = await currentManager(this.dataSource)
      .getRepository(HubSpaceTypeormEntity)
      .findOne({ select: { organizationId: true }, where: { hubId, spaceId } });
    if (!row) return;
    await runInOrganizationScope(this.dataSource, row.organizationId, (m) =>
      m.query(
        `UPDATE hub_space SET deleted_at = now(), updated_at = now()
          WHERE hub_id = $1 AND space_id = $2 AND organization_id = $3 AND deleted_at IS NULL`,
        [hubId, spaceId, row.organizationId],
      ),
    );
  }

  async list(hubId: string): Promise<HubSpaceRef[]> {
    if (!validate(hubId)) return [];
    const rows = await currentManager(this.dataSource)
      .getRepository(HubSpaceTypeormEntity)
      .find({ where: { hubId }, order: { spaceId: 'ASC' } });
    return rows.map((r) => ({
      hubId: r.hubId,
      spaceId: r.spaceId,
      organizationId: r.organizationId,
      addedByUserId: r.addedByUserId,
    }));
  }
}
