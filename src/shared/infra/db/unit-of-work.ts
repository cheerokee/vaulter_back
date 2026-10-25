import { AsyncLocalStorage } from 'node:async_hooks';
import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

// EntityManager da transação ativa, propagado pela cadeia assíncrona (inclusive entre módulos).
const ambient = new AsyncLocalStorage<EntityManager>();

function activeManager(dataSource: DataSource): EntityManager | undefined {
  const manager = ambient.getStore();
  // Só vale para o mesmo DataSource: uma conexão de outro banco/papel não entra na transação.
  return manager?.connection === dataSource ? manager : undefined;
}

// Manager que os repositórios devem usar em cada operação: o da transação ativa, se houver, ou o
// `dataSource.manager` (cada comando em autocommit, como antes). Nunca guardar o Repository em campo.
export function currentManager(dataSource: DataSource): EntityManager {
  return activeManager(dataSource) ?? dataSource.manager;
}

// Roda `work` numa transação; se já houver uma ativa no mesmo DataSource, reaproveita (aninhado não
// abre savepoint: um erro em qualquer nível desfaz tudo).
export function runInTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const active = activeManager(dataSource);
  if (active) return work(active);
  return dataSource.transaction((manager) =>
    ambient.run(manager, () => work(manager)),
  );
}

export interface UnitOfWorkContext {
  organizationId?: string;
  userId?: string;
}

// `set_config(..., true)` vale até o fim da transação: não vaza para a próxima da mesma conexão.
export async function setTransactionContext(
  manager: EntityManager,
  ctx: UnitOfWorkContext,
): Promise<void> {
  if (ctx.organizationId !== undefined) {
    await manager.query(`SELECT set_config('app.organization_id', $1, true)`, [
      ctx.organizationId,
    ]);
  }
  if (ctx.userId !== undefined) {
    await manager.query(`SELECT set_config('app.user_id', $1, true)`, [
      ctx.userId,
    ]);
  }
}

@Injectable()
export class UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  // Tudo que os repositórios fizerem dentro de `work` entra na mesma transação.
  run<T>(work: () => Promise<T>): Promise<T> {
    return runInTransaction(this.dataSource, () => work());
  }

  // Contexto do RLS (`app.organization_id`, `app.user_id`) para o resto da transação ativa.
  async setContext(ctx: UnitOfWorkContext): Promise<void> {
    const manager = activeManager(this.dataSource);
    if (!manager) {
      throw new Error(
        'UnitOfWork.setContext requires an active unit of work (call it inside UnitOfWork.run).',
      );
    }
    await setTransactionContext(manager, ctx);
  }
}
