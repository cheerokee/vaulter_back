import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  decodeCursor,
  pageFrom,
  type CursorPage,
  type CursorPageRequest,
} from '../../../shared/domain/pagination.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type {
  PlatformPermission,
  PlatformRoleKey,
} from '../../domain/platform-catalog.js';
import {
  PlatformRoleRepository,
  type StaffRoles,
} from '../../domain/platform-role.repository.js';

// SQL direto sobre user_platform_role + catálogo (sem RLS: as tabelas da plataforma não têm organização). O runtime
// tem SELECT/INSERT/UPDATE em user_platform_role e só SELECT no catálogo. Cada operação usa o manager corrente, para
// entrar na transação do UnitOfWork quando houver uma.
@Injectable()
export class PlatformRoleTypeormRepository extends PlatformRoleRepository {
  constructor(private readonly dataSource: DataSource) {
    super();
  }

  private query<T>(sql: string, params: unknown[] = []): Promise<T> {
    return currentManager(this.dataSource).query(sql, params);
  }

  async permissionsOf(userId: string): Promise<PlatformPermission[]> {
    const rows = await this.query<{ key: PlatformPermission }[]>(
      `SELECT DISTINCT pp.key
         FROM user_platform_role upr
         JOIN platform_roles pr ON pr.id = upr.platform_role_id AND pr.deleted_at IS NULL
         JOIN platform_role_permission prp ON prp.platform_role_id = pr.id AND prp.deleted_at IS NULL
         JOIN platform_permissions pp ON pp.id = prp.platform_permission_id AND pp.deleted_at IS NULL
        WHERE upr.user_id = $1 AND upr.deleted_at IS NULL
        ORDER BY pp.key`,
      [userId],
    );
    return rows.map((r) => r.key);
  }

  async rolesOf(userId: string): Promise<PlatformRoleKey[]> {
    const rows = await this.query<{ key: PlatformRoleKey }[]>(
      `SELECT pr.key
         FROM user_platform_role upr
         JOIN platform_roles pr ON pr.id = upr.platform_role_id AND pr.deleted_at IS NULL
        WHERE upr.user_id = $1 AND upr.deleted_at IS NULL
        ORDER BY pr.key`,
      [userId],
    );
    return rows.map((r) => r.key);
  }

  async hasAnyRole(userId: string): Promise<boolean> {
    return (await this.rolesOf(userId)).length > 0;
  }

  // Upsert atômico na chave composta: cria ou limpa a lápide da mesma linha. Já viva, o WHERE do DO UPDATE não casa
  // e o RETURNING sai vazio (nada mudou).
  async grant(
    userId: string,
    roleKey: PlatformRoleKey,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.query<unknown[]>(
      `INSERT INTO user_platform_role (user_id, platform_role_id, created_at, updated_at)
       SELECT $1, pr.id, $3, $3 FROM platform_roles pr WHERE pr.key = $2 AND pr.deleted_at IS NULL
       ON CONFLICT (user_id, platform_role_id) DO UPDATE
          SET deleted_at = NULL, updated_at = EXCLUDED.updated_at
        WHERE user_platform_role.deleted_at IS NOT NULL
       RETURNING user_id`,
      [userId, roleKey, now],
    );
    return rows.length > 0;
  }

  async revoke(
    userId: string,
    roleKey: PlatformRoleKey,
    now: Date,
  ): Promise<boolean> {
    // UPDATE ... RETURNING no driver pg: [linhas, quantidade].
    const [rows] = await this.query<[unknown[], number]>(
      `UPDATE user_platform_role upr
          SET deleted_at = $3, updated_at = $3
         FROM platform_roles pr
        WHERE pr.id = upr.platform_role_id AND pr.key = $2 AND pr.deleted_at IS NULL
          AND upr.user_id = $1 AND upr.deleted_at IS NULL
       RETURNING upr.user_id`,
      [userId, roleKey, now],
    );
    return rows.length > 0;
  }

  // SELECT ... FOR UPDATE na transação ambiente: o lock vale até o fim do UnitOfWork.run de quem chamou.
  async lockAdmins(): Promise<string[]> {
    if (!currentManager(this.dataSource).queryRunner?.isTransactionActive) {
      throw new Error(
        'PlatformRoleRepository.lockAdmins requires an active unit of work (call it inside UnitOfWork.run).',
      );
    }
    const rows = await this.query<{ user_id: string }[]>(
      `SELECT upr.user_id
         FROM user_platform_role upr
         JOIN platform_roles pr ON pr.id = upr.platform_role_id
        WHERE pr.key = 'platform_admin' AND pr.deleted_at IS NULL
          AND upr.deleted_at IS NULL
        ORDER BY upr.user_id
          FOR UPDATE OF upr`,
    );
    return rows.map((r) => r.user_id);
  }

  async listStaff(page: CursorPageRequest): Promise<CursorPage<StaffRoles>> {
    const after = page.cursor ? decodeCursor(page.cursor) : null;
    const rows = await this.query<
      { user_id: string; roles: PlatformRoleKey[] }[]
    >(
      `SELECT upr.user_id, array_agg(pr.key ORDER BY pr.key) AS roles
         FROM user_platform_role upr
         JOIN platform_roles pr ON pr.id = upr.platform_role_id AND pr.deleted_at IS NULL
        WHERE upr.deleted_at IS NULL AND ($1::uuid IS NULL OR upr.user_id > $1::uuid)
        GROUP BY upr.user_id
        ORDER BY upr.user_id
        LIMIT $2`,
      [after, page.limit + 1],
    );
    return pageFrom(
      rows.map((r) => ({ userId: r.user_id, roles: r.roles })),
      page.limit,
      (r) => r.userId,
    );
  }
}
