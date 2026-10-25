import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  decodeCursor,
  encodeCursor,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { runInOrganizationScope } from '../../../shared/infra/db/organization-scope.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { Membership, OrgRoleKey } from '../../domain/membership.js';
import { MembershipRepository } from '../../domain/membership.repository.js';

type MemberRow = { user_id: string; role_key: OrgRoleKey; created_at: Date };

// Membro = vínculo ativo em user_organization + atribuição de papel de organização ativa.
const MEMBERS_SQL = `
  SELECT uo.user_id, r.key AS role_key, uo.created_at
    FROM user_organization uo
    JOIN role_assignments ra
      ON ra.organization_id = uo.organization_id AND ra.user_id = uo.user_id
     AND ra.scope_type = 'organization' AND ra.deleted_at IS NULL
    JOIN roles r ON r.id = ra.role_id
   WHERE uo.organization_id = $1 AND uo.deleted_at IS NULL`;

@Injectable()
export class MembershipTypeormRepository extends MembershipRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  // Tabela de ligação: voltar limpa a lápide na mesma linha; num vínculo ativo, não faz nada.
  async add(orgId: string, userId: string, now: Date): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, (m) =>
      m.query(
        `INSERT INTO user_organization (organization_id, user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $3)
         ON CONFLICT (organization_id, user_id) DO UPDATE
            SET deleted_at = NULL, updated_at = now()
          WHERE user_organization.deleted_at IS NOT NULL`,
        [orgId, userId, now],
      ),
    );
  }

  // Lápide no vínculo e na atribuição de papel da organização, na mesma transação (quem sai não fica como
  // administrador para lockOrgAdmins/countAdmins).
  async remove(orgId: string, userId: string): Promise<void> {
    await runInOrganizationScope(this.dataSource, orgId, async (m) => {
      await m.query(
        `UPDATE user_organization SET deleted_at = now(), updated_at = now()
          WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL`,
        [orgId, userId],
      );
      await m.query(
        `UPDATE role_assignments SET deleted_at = now(), updated_at = now()
          WHERE organization_id = $1 AND user_id = $2 AND scope_type = 'organization' AND deleted_at IS NULL`,
        [orgId, userId],
      );
    });
  }

  async find(orgId: string, userId: string): Promise<Membership | null> {
    const rows: MemberRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) => m.query(`${MEMBERS_SQL} AND uo.user_id = $2`, [orgId, userId]),
    );
    const row = rows[0];
    return row ? toMembership(orgId, row) : null;
  }

  // FOR SHARE só faz sentido numa transação que dure o caso de uso inteiro (o lock passa do savepoint do
  // contexto para a transação de fora). Usado pelo `spaces` ao pôr alguém num espaço: mesma ordem da saída da
  // organização (linha do vínculo, depois o espaço).
  async lockActive(orgId: string, userId: string): Promise<boolean> {
    if (!currentManager(this.dataSource).queryRunner?.isTransactionActive) {
      throw new Error(
        'MembershipRepository.lockActive requires an active unit of work (call it inside UnitOfWork.run).',
      );
    }
    const rows: unknown[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT 1 FROM user_organization
            WHERE organization_id = $1 AND user_id = $2 AND deleted_at IS NULL
              FOR SHARE`,
          [orgId, userId],
        ),
    );
    return rows.length > 0;
  }

  // Ordem por user_id (v7); o cursor é o último user_id.
  async list(
    orgId: string,
    page: CursorPageRequest,
  ): Promise<CursorPage<Membership>> {
    const cursor = page.cursor ? decodeCursor(page.cursor) : null;
    const rows: MemberRow[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `${MEMBERS_SQL} AND ($2::uuid IS NULL OR uo.user_id > $2::uuid)
           ORDER BY uo.user_id ASC LIMIT $3`,
          [orgId, cursor, page.limit + 1],
        ),
    );
    const items = rows.slice(0, page.limit).map((r) => toMembership(orgId, r));
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > page.limit && last ? encodeCursor(last.userId) : null,
    };
  }

  async countActive(orgId: string): Promise<number> {
    const rows: { n: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT count(*) AS n FROM user_organization WHERE organization_id = $1 AND deleted_at IS NULL`,
          [orgId],
        ),
    );
    return Number(rows[0]!.n);
  }

  async countAdmins(orgId: string): Promise<number> {
    const rows: { n: string }[] = await runInOrganizationScope(
      this.dataSource,
      orgId,
      (m) =>
        m.query(
          `SELECT count(*) AS n FROM (${MEMBERS_SQL}) members WHERE members.role_key = 'org_admin'`,
          [orgId],
        ),
    );
    return Number(rows[0]!.n);
  }
}

function toMembership(orgId: string, row: MemberRow): Membership {
  return {
    organizationId: orgId,
    userId: row.user_id,
    roleKey: row.role_key,
    joinedAt: row.created_at,
  };
}
