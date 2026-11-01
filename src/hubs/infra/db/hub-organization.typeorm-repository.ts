import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource } from 'typeorm';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  currentManager,
  runWithContext,
} from '../../../shared/infra/db/unit-of-work.js';
import type { HubOrganizationLink } from '../../domain/hub-organization-link.js';
import { HubOrganizationRepository } from '../../domain/hub-organization.repository.js';
import { hubNotFound, requireUnitOfWork, updatedRows } from './db-helpers.js';
import { HubOrganizationTypeormEntity } from './hub-organization.entity.js';
import { HubOrganizationMapper } from './hub-organization.mapper.js';

// Escrita e lock sempre no escopo da organização da linha (org_isolation é a única policy de escrita), como no
// `spaces`. Leitura no contexto ambiente: org_isolation, membro ativo da organização, dono do Hub
// (`hub_owner_user_id`) ou o próprio Hub (`app.hub_id`). Linhas com lápide ficam fora das leituras.
@Injectable()
export class HubOrganizationTypeormRepository extends HubOrganizationRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private get repo() {
    return currentManager(this.dataSource).getRepository(
      HubOrganizationTypeormEntity,
    );
  }

  async find(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null> {
    if (!validate(hubId) || !validate(organizationId)) return null;
    const row = await this.repo.findOne({ where: { hubId, organizationId } });
    return row ? HubOrganizationMapper.toDomain(row) : null;
  }

  // Confere o Hub (existe e não está desregistrado) com o contexto do próprio Hub, só dentro deste trecho: um admin
  // aprovando um pedido pendente não vê o Hub pelas policies dele. Depois, 1) atualiza a linha de (Hub,
  // organização), limpando a lápide, ou 2) insere com o dono do Hub; o ON CONFLICT cobre a corrida com outro
  // insert. Hub inexistente ou desregistrado -> hub-not-found nos dois caminhos. A corrida com um desregistro
  // concorrente fica com quem desregistra (trava os vínculos FOR UPDATE antes de gravar as lápides).
  async upsert(link: HubOrganizationLink): Promise<void> {
    if (!validate(link.hubId)) throw hubNotFound();
    const params = [
      link.hubId,
      link.organizationId,
      link.status,
      link.requestedByUserId,
      link.ownerApprovedByUserId,
      link.ownerApprovedAt,
      link.orgApprovedByUserId,
      link.orgApprovedAt,
    ];
    await runWithContext(
      this.dataSource,
      { organizationId: link.organizationId, hubId: link.hubId },
      async (m) => {
        const hub: { owner_user_id: string }[] = await m.query(
          `SELECT owner_user_id FROM hubs WHERE id = $1 AND deleted_at IS NULL`,
          [link.hubId],
        );
        if (hub.length === 0) throw hubNotFound();
        const updated = updatedRows(
          await m.query(
            `UPDATE hub_organization
                SET status = $3, requested_by_user_id = $4,
                    owner_approved_by_user_id = $5, owner_approved_at = $6,
                    org_approved_by_user_id = $7, org_approved_at = $8,
                    deleted_at = NULL, updated_at = now()
              WHERE hub_id = $1 AND organization_id = $2
             RETURNING hub_id`,
            params,
          ),
        );
        if (updated.length > 0) return;
        const inserted: { hub_id: string }[] = await m.query(
          `INSERT INTO hub_organization (
             hub_id, organization_id, hub_owner_user_id, status, requested_by_user_id,
             owner_approved_by_user_id, owner_approved_at, org_approved_by_user_id, org_approved_at, created_at)
           VALUES ($1, $2, $10, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()))
           ON CONFLICT (hub_id, organization_id) DO UPDATE
             SET status = EXCLUDED.status,
                 requested_by_user_id = EXCLUDED.requested_by_user_id,
                 owner_approved_by_user_id = EXCLUDED.owner_approved_by_user_id,
                 owner_approved_at = EXCLUDED.owner_approved_at,
                 org_approved_by_user_id = EXCLUDED.org_approved_by_user_id,
                 org_approved_at = EXCLUDED.org_approved_at,
                 deleted_at = NULL, updated_at = now()
           RETURNING hub_id`,
          [...params, link.createdAt ?? null, hub[0]!.owner_user_id],
        );
        if (inserted.length === 0) throw hubNotFound();
      },
    );
  }

  async list(hubId: string): Promise<HubOrganizationLink[]> {
    if (!validate(hubId)) return [];
    const rows = await this.repo.find({
      where: { hubId },
      order: { organizationId: 'ASC' },
    });
    return rows.map((r) => HubOrganizationMapper.toDomain(r));
  }

  async listActiveOrgIds(hubId: string): Promise<string[]> {
    if (!validate(hubId)) return [];
    const rows = await this.repo.find({
      select: { organizationId: true },
      where: { hubId, status: 'approved' },
      order: { organizationId: 'ASC' },
    });
    return rows.map((r) => r.organizationId);
  }

  // FOR UPDATE exige a policy de UPDATE (org_isolation): roda no escopo da organização. O lock passa do savepoint
  // do contexto para a transação de fora e vale até o fim do UnitOfWork.run.
  async lockForUpdate(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null> {
    requireUnitOfWork(
      this.dataSource,
      'HubOrganizationRepository.lockForUpdate',
    );
    if (!validate(hubId) || !validate(organizationId)) return null;
    const row = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(HubOrganizationTypeormEntity).findOne({
          where: { hubId, organizationId },
          lock: { mode: 'pessimistic_write' },
        }),
    );
    return row ? HubOrganizationMapper.toDomain(row) : null;
  }
}
