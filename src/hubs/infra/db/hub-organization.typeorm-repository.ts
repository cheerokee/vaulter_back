import { Injectable } from '@nestjs/common';
import { validate } from 'uuid';
import { DataSource, MoreThan } from 'typeorm';
import type { KeysetSlice } from '../../../shared/domain/pagination.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import {
  currentManager,
  runWithContext,
} from '../../../shared/infra/db/unit-of-work.js';
import type {
  HubLinkStatus,
  HubOrganizationLink,
} from '../../domain/hub-organization-link.js';
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
  // insert. Hub inexistente ou desregistrado -> hub-not-found nos dois caminhos.
  // Ordem de locks: linha do Hub (FOR SHARE aqui; FOR UPDATE no desregistro) -> linha do vínculo -> espaço (ganchos
  // do `spaces`). Quem chama não pode travar o vínculo ou um espaço antes de chamar upsert.
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
        // FOR SHARE (a policy de UPDATE de hubs vale para o contexto do próprio Hub): serializa com o desregistro,
        // que trava o Hub FOR UPDATE antes de gravar a lápide. Quem espera relê a linha depois do COMMIT e, já com
        // lápide, não a acha -> hub-not-found, inclusive no caminho do INSERT (vínculo novo, que o desregistro não
        // teria como travar).
        const hub: { owner_user_id: string }[] = await m.query(
          `SELECT owner_user_id FROM hubs WHERE id = $1 AND deleted_at IS NULL FOR SHARE`,
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

  async list(
    hubId: string,
    slice?: KeysetSlice,
  ): Promise<HubOrganizationLink[]> {
    if (!validate(hubId)) return [];
    const rows = await this.repo.find({
      where: {
        hubId,
        ...(slice?.after ? { organizationId: MoreThan(slice.after) } : {}),
      },
      order: { organizationId: 'ASC' },
      ...(slice ? { take: slice.limit } : {}),
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

  // FOR SHARE também exige a policy de UPDATE (org_isolation): roda no escopo da organização. Só a linha viva.
  async lockForShare(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null> {
    requireUnitOfWork(
      this.dataSource,
      'HubOrganizationRepository.lockForShare',
    );
    if (!validate(hubId) || !validate(organizationId)) return null;
    const row = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(HubOrganizationTypeormEntity).findOne({
          where: { hubId, organizationId },
          lock: { mode: 'pessimistic_read' },
        }),
    );
    return row ? HubOrganizationMapper.toDomain(row) : null;
  }

  async findInOrganization(
    hubId: string,
    organizationId: string,
  ): Promise<HubOrganizationLink | null> {
    if (!validate(hubId) || !validate(organizationId)) return null;
    const row = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m
          .getRepository(HubOrganizationTypeormEntity)
          .findOne({ where: { hubId, organizationId } }),
    );
    return row ? HubOrganizationMapper.toDomain(row) : null;
  }

  // Com lápides e vínculos recusados/revogados: a Sala pode ter ficado em qualquer organização que já foi vinculada.
  async listAllOrgIds(hubId: string): Promise<string[]> {
    if (!validate(hubId)) return [];
    const rows = await this.repo.find({
      select: { organizationId: true },
      where: { hubId },
      withDeleted: true,
      order: { organizationId: 'ASC' },
    });
    return rows.map((r) => r.organizationId);
  }

  // `hub_owner_user_id` (cópia do dono, com FK composta para hubs) responde "Hubs desta pessoa vinculados a esta
  // organização" com uma consulta só, no escopo da organização, sem ler hubs.
  async listOwnedInOrganization(
    organizationId: string,
    ownerUserId: string,
  ): Promise<HubOrganizationLink[]> {
    if (!validate(organizationId) || !validate(ownerUserId)) return [];
    const rows = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(HubOrganizationTypeormEntity).find({
          where: { organizationId, hubOwnerUserId: ownerUserId },
          order: { hubId: 'ASC' },
        }),
    );
    return rows.map((r) => HubOrganizationMapper.toDomain(r));
  }

  // Escopo da organização (org_isolation): pendentes de Hubs que o admin ainda não vê também aparecem.
  async listOfOrganization(
    organizationId: string,
    filter: { status?: HubLinkStatus; after?: string; limit: number },
  ): Promise<HubOrganizationLink[]> {
    if (!validate(organizationId)) return [];
    const rows = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(HubOrganizationTypeormEntity).find({
          where: {
            organizationId,
            ...(filter.status ? { status: filter.status } : {}),
            ...(filter.after ? { hubId: MoreThan(filter.after) } : {}),
          },
          order: { hubId: 'ASC' },
          take: filter.limit,
        }),
    );
    return rows.map((r) => HubOrganizationMapper.toDomain(r));
  }

  async listApprovedHubIdsOfOrganization(
    organizationId: string,
  ): Promise<string[]> {
    if (!validate(organizationId)) return [];
    const rows = await runInOrganizationScope(
      this.dataSource,
      organizationId,
      (m) =>
        m.getRepository(HubOrganizationTypeormEntity).find({
          select: { hubId: true },
          where: { organizationId, status: 'approved' },
          order: { hubId: 'ASC' },
        }),
    );
    return rows.map((r) => r.hubId);
  }

  // Desregistro: uma organização por vez, em ordem de id (a ordem dos locks das linhas), cada UPDATE no escopo da
  // própria organização (org_isolation é a única policy de escrita). Pendente/aprovado vira revogado; recusado e
  // revogado ficam como estão; todos ganham a lápide.
  async tombstoneAllOfHub(hubId: string): Promise<string[]> {
    if (!validate(hubId)) return [];
    const live = await this.repo.find({
      select: { organizationId: true },
      where: { hubId },
      order: { organizationId: 'ASC' },
    });
    const done: string[] = [];
    for (const { organizationId } of live) {
      const rows = updatedRows<{ organization_id: string }>(
        await runInOrganizationScope(this.dataSource, organizationId, (m) =>
          m.query(
            `UPDATE hub_organization
                SET status = CASE WHEN status IN ('pending', 'approved') THEN 'revoked' ELSE status END,
                    deleted_at = now(), updated_at = now()
              WHERE hub_id = $1 AND organization_id = $2 AND deleted_at IS NULL
             RETURNING organization_id`,
            [hubId, organizationId],
          ),
        ),
      );
      if (rows.length > 0) done.push(organizationId);
    }
    return done;
  }
}
