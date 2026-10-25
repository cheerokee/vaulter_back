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

// Roda `work` numa transação.
// - Aninhado (já há uma ativa no mesmo DataSource): abre um SAVEPOINT na mesma conexão (o
//   `EntityManager.transaction` do TypeORM faz isso quando o manager já tem queryRunner). Se `work`
//   falhar, só o que ele fez é desfeito, e o erro sobe; quem capturar pode seguir com a transação de fora.
// - Externo: abre a transação e, antes do COMMIT, faz uma sonda (`SELECT 1`). Se um erro de banco foi
//   engolido sem savepoint, a transação está abortada e a sonda falha com 25P02, em vez de o COMMIT
//   virar um ROLLBACK silencioso (o Postgres responde ROLLBACK sem erro e o TypeORM não confere).
export function runInTransaction<T>(
  dataSource: DataSource,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const active = activeManager(dataSource);
  if (active) {
    return active.transaction((manager) =>
      ambient.run(manager, () => work(manager)),
    );
  }
  return dataSource.transaction((manager) =>
    ambient.run(manager, async () => {
      const result = await work(manager);
      await manager.query('SELECT 1');
      return result;
    }),
  );
}

export interface UnitOfWorkContext {
  organizationId?: string;
  userId?: string;
}

const SETTINGS = {
  organizationId: 'app.organization_id',
  userId: 'app.user_id',
} as const satisfies Record<keyof UnitOfWorkContext, string>;

// `set_config(..., true)` vale até o fim da transação: não vaza para a próxima da mesma conexão.
export async function setTransactionContext(
  manager: EntityManager,
  ctx: UnitOfWorkContext,
): Promise<void> {
  for (const key of Object.keys(SETTINGS) as (keyof UnitOfWorkContext)[]) {
    const value = ctx[key];
    if (value === undefined) continue;
    await manager.query(`SELECT set_config($1, $2, true)`, [
      SETTINGS[key],
      value,
    ]);
  }
}

async function readTransactionContext(
  manager: EntityManager,
  ctx: UnitOfWorkContext,
): Promise<UnitOfWorkContext> {
  const previous: UnitOfWorkContext = {};
  for (const key of Object.keys(SETTINGS) as (keyof UnitOfWorkContext)[]) {
    if (ctx[key] === undefined) continue;
    const rows: { v: string }[] = await manager.query(
      `SELECT COALESCE(current_setting($1, true), '') AS v`,
      [SETTINGS[key]],
    );
    previous[key] = rows[0]!.v;
  }
  return previous;
}

// Roda `work` com o contexto do RLS. Fora de uma transação, abre a própria. Dentro de uma, entra nela
// (num savepoint) e, ao terminar, devolve o contexto anterior: assim dá para gravar em duas organizações
// na mesma transação. Em caso de erro, o ROLLBACK TO SAVEPOINT já desfaz o `set_config`.
export async function runWithContext<T>(
  dataSource: DataSource,
  ctx: UnitOfWorkContext,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  const active = activeManager(dataSource);
  const previous = active ? await readTransactionContext(active, ctx) : null;
  const result = await runInTransaction(dataSource, async (manager) => {
    await setTransactionContext(manager, ctx);
    return work(manager);
  });
  if (active && previous) await setTransactionContext(active, previous);
  return result;
}

@Injectable()
export class UnitOfWork {
  constructor(private readonly dataSource: DataSource) {}

  // Tudo que os repositórios fizerem dentro de `work` entra na mesma transação. Aninhado vira savepoint.
  run<T>(work: () => Promise<T>): Promise<T> {
    return runInTransaction(this.dataSource, work);
  }

  // Contexto do RLS (`app.organization_id`, `app.user_id`) para o resto da transação ativa. Para uma
  // troca temporária (ex.: gravar em outra organização no meio do `run`), use `withContext`.
  async setContext(ctx: UnitOfWorkContext): Promise<void> {
    const manager = activeManager(this.dataSource);
    if (!manager) {
      throw new Error(
        'UnitOfWork.setContext requires an active unit of work (call it inside UnitOfWork.run).',
      );
    }
    await setTransactionContext(manager, ctx);
  }

  // Roda `work` com o contexto dado e restaura o anterior ao terminar (abre transação se não houver).
  withContext<T>(ctx: UnitOfWorkContext, work: () => Promise<T>): Promise<T> {
    return runWithContext(this.dataSource, ctx, work);
  }
}
