import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { runWithContext } from '../../../shared/infra/db/unit-of-work.js';
import type { OrgRoleKey } from '../../domain/membership.js';
import type { Organization } from '../../domain/organization.js';
import {
  OrganizationRepository,
  type OrganizationWithRole,
} from '../../domain/organization.repository.js';
import { OrganizationTypeormEntity } from './organization.entity.js';
import { OrganizationMapper } from './organization.mapper.js';
import { RoleAssignmentTypeormEntity } from './role-assignment.entity.js';
import { RoleTypeormEntity } from './role.entity.js';
import { UserOrganizationTypeormEntity } from './user-organization.entity.js';

// Todo método roda na transação ambiente (ou na própria) com o contexto de RLS que precisa.
@Injectable()
export class OrganizationTypeormRepository extends OrganizationRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // A policy de INSERT exige `app.organization_id` igual ao id novo.
  async create(organization: Organization): Promise<void> {
    await runInOrganizationScope(this.dataSource, organization.id, (m) =>
      m
        .getRepository(OrganizationTypeormEntity)
        .insert(OrganizationMapper.toPersistence(organization)),
    );
  }

  async save(organization: Organization): Promise<void> {
    const {
      id,
      createdAt: _createdAt,
      ...rest
    } = OrganizationMapper.toPersistence(organization);
    await runInOrganizationScope(this.dataSource, organization.id, (m) =>
      m.getRepository(OrganizationTypeormEntity).update({ id: id! }, rest),
    );
  }

  // Não confere vínculo: quem chama (OrganizationAccess) decide se o usuário pode ver.
  async findById(orgId: string): Promise<Organization | null> {
    const row = await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.getRepository(OrganizationTypeormEntity).findOne({
        where: { id: orgId },
      }),
    );
    return row ? OrganizationMapper.toDomain(row) : null;
  }

  // Atravessa organizações só com `app.user_id`: organizations pela policy de membro (EXISTS em
  // user_organization), user_organization e role_assignments pela policy de leitura própria. Ordem por id
  // (v7 = ordem de criação).
  // ATENÇÃO (papéis próprios, modo avançado): sem `app.organization_id`, a policy roles_read só mostra papéis
  // de fábrica; um membro com papel próprio sumiria desta lista (INNER JOIN em roles). Rever quando existirem.
  async listForUser(
    userId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<OrganizationWithRole>> {
    const { entities, raw } = await runWithContext(
      this.dataSource,
      { userId },
      (m) => {
        const qb = m
          .getRepository(OrganizationTypeormEntity)
          .createQueryBuilder('o')
          .innerJoin(
            UserOrganizationTypeormEntity,
            'uo',
            'uo.organization_id = o.id AND uo.user_id = :userId AND uo.deleted_at IS NULL',
            { userId },
          )
          .innerJoin(
            RoleAssignmentTypeormEntity,
            'ra',
            `ra.organization_id = o.id AND ra.user_id = :userId AND ra.scope_type = 'organization' AND ra.deleted_at IS NULL`,
          )
          .innerJoin(RoleTypeormEntity, 'r', 'r.id = ra.role_id')
          .addSelect('r.key', 'role_key')
          .orderBy('o.id', 'ASC')
          .limit(page.limit + 1);
        if (page.cursor) {
          qb.andWhere('o.id > :cursor', { cursor: decodeCursor(page.cursor) });
        }
        return qb.getRawAndEntities<{ o_id: string; role_key: OrgRoleKey }>();
      },
    );
    const roleOf = new Map(raw.map((r) => [r.o_id, r.role_key]));
    const items = entities.slice(0, page.limit).map((row) => ({
      organization: OrganizationMapper.toDomain(row),
      roleKey: roleOf.get(row.id)!,
    }));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        entities.length > page.limit && last
          ? encodeCursor(last.organization.id)
          : null,
    };
  }
}
