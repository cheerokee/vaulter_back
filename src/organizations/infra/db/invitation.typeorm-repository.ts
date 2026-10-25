import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { runWithContext } from '../../../shared/infra/db/unit-of-work.js';
import type { Invitation } from '../../domain/invitation.js';
import { InvitationRepository } from '../../domain/invitation.repository.js';
import type { OrgRoleKey } from '../../domain/membership.js';
import { orgFactoryRoleId } from './factory-roles.js';
import { OrganizationInvitationTypeormEntity } from './organization-invitation.entity.js';
import { OrganizationInvitationMapper } from './organization-invitation.mapper.js';
import { RoleTypeormEntity } from './role.entity.js';

@Injectable()
export class InvitationTypeormRepository extends InvitationRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  async create(invitation: Invitation): Promise<void> {
    await runInOrganizationScope(
      this.dataSource,
      invitation.organizationId,
      async (m) => {
        const roleId = await orgFactoryRoleId(m, invitation.roleKey);
        await m
          .getRepository(OrganizationInvitationTypeormEntity)
          .insert(
            OrganizationInvitationMapper.toPersistence(invitation, roleId),
          );
      },
    );
  }

  // Sem organização no contexto ainda: `app.invitation_token_hash` abre só o convite desse hash (policy
  // invitation_by_token); runWithContext restaura o valor anterior ao sair, então não fica no UnitOfWork.
  // Papel do convite é de fábrica (visível sem organização pela policy roles_read).
  async findByTokenHash(tokenHash: string): Promise<Invitation | null> {
    const [invitation] = await runWithContext(
      this.dataSource,
      { invitationTokenHash: tokenHash },
      (m) => this.select(m, { tokenHash, limit: 1 }),
    );
    return invitation ?? null;
  }

  // Pendentes e ainda válidos; mais novos primeiro.
  async listPending(
    orgId: string,
    page: CursorPageRequest,
    now: Date,
  ): Promise<CursorPage<Invitation>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : undefined;
    const rows = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      this.select(m, {
        organizationId: orgId,
        pendingAt: now,
        before: cursor,
        limit: page.limit + 1,
      }),
    );
    const items = rows.slice(0, page.limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > page.limit && last ? encodeCursor(last.id) : null,
    };
  }

  async revoke(orgId: string, id: string): Promise<boolean> {
    const result = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m
        .createQueryBuilder()
        .update(OrganizationInvitationTypeormEntity)
        .set({ status: 'revoked' })
        .where(`id = :id AND organization_id = :orgId AND status = 'pending'`, {
          id,
          orgId,
        })
        .execute(),
    );
    return (result.affected ?? 0) > 0;
  }

  // UPDATE condicional e atômico: num aceite concorrente, o segundo espera o lock da linha, reavalia o WHERE
  // depois do COMMIT do primeiro e não altera nada.
  async markAccepted(
    orgId: string,
    id: string,
    userId: string,
    now: Date,
  ): Promise<boolean> {
    const result = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m
        .createQueryBuilder()
        .update(OrganizationInvitationTypeormEntity)
        .set({ status: 'accepted', acceptedByUserId: userId, acceptedAt: now })
        .where(`id = :id AND organization_id = :orgId AND status = 'pending'`, {
          id,
          orgId,
        })
        .andWhere('expires_at > :now', { now })
        .andWhere('deleted_at IS NULL')
        .execute(),
    );
    return (result.affected ?? 0) > 0;
  }

  private async select(
    m: EntityManager,
    filter: {
      id?: string;
      tokenHash?: string;
      organizationId?: string;
      pendingAt?: Date;
      before?: string;
      limit: number;
    },
  ): Promise<Invitation[]> {
    const qb = m
      .getRepository(OrganizationInvitationTypeormEntity)
      .createQueryBuilder('i')
      .innerJoin(RoleTypeormEntity, 'r', 'r.id = i.role_id')
      .addSelect('r.key', 'role_key')
      .orderBy('i.id', 'DESC')
      .limit(filter.limit);
    if (filter.id) qb.andWhere('i.id = :id', { id: filter.id });
    if (filter.tokenHash) {
      qb.andWhere('i.token_hash = :tokenHash', { tokenHash: filter.tokenHash });
    }
    if (filter.organizationId) {
      qb.andWhere('i.organization_id = :orgId', {
        orgId: filter.organizationId,
      });
    }
    // Mesmo relógio do markAccepted (o `now` da aplicação), não o now() do banco.
    if (filter.pendingAt) {
      qb.andWhere(`i.status = 'pending' AND i.expires_at > :pendingAt`, {
        pendingAt: filter.pendingAt,
      });
    }
    if (filter.before) qb.andWhere('i.id < :before', { before: filter.before });
    const { entities, raw } = await qb.getRawAndEntities<{
      i_id: string;
      role_key: OrgRoleKey;
    }>();
    const roleOf = new Map(raw.map((r) => [r.i_id, r.role_key]));
    return entities.map((row) =>
      OrganizationInvitationMapper.toDomain(row, roleOf.get(row.id)!),
    );
  }
}
