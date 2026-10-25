import type { DataSource, EntityManager } from 'typeorm';
import {
  encodeCursor,
  type CursorPage,
} from '../../../shared/domain/pagination.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';
import type { SpaceRoleKey } from '../../domain/space-membership.js';

// Locks (`FOR UPDATE`) só servem dentro de uma transação que dure o caso de uso inteiro.
export function requireUnitOfWork(
  dataSource: DataSource,
  method: string,
): void {
  if (!currentManager(dataSource).queryRunner?.isTransactionActive) {
    throw new Error(
      `${method} requires an active unit of work (call it inside UnitOfWork.run).`,
    );
  }
}

// Id do papel de fábrica de espaço. Papéis de fábrica são visíveis em qualquer contexto (policy roles_read).
export async function spaceFactoryRoleId(
  manager: EntityManager,
  key: SpaceRoleKey,
): Promise<string> {
  const rows: { id: string }[] = await manager.query(
    `SELECT id FROM roles
      WHERE key = $1 AND organization_id IS NULL AND scope_type = 'space' AND deleted_at IS NULL`,
    [key],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error(`Factory role ${key} is missing from the catalog.`);
  return id;
}

// No driver pg, o `query` do TypeORM devolve `[rows, rowCount]` para UPDATE/DELETE e só `rows` para o resto.
export function updatedRows<T>(raw: unknown): T[] {
  return (raw as [T[], number])[0];
}

// Página de cursor a partir de `limit + 1` linhas; o cursor é o id do último item.
export function toCursorPage<T>(
  items: T[],
  hasMore: boolean,
  idOf: (item: T) => string,
): CursorPage<T> {
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(idOf(last)) : null,
  };
}

// Ids sem repetição, em ordem estável.
export function distinctSorted(ids: string[]): string[] {
  return [...new Set(ids)].sort();
}
