import type { DataSource, EntityManager } from 'typeorm';
import {
  currentManager,
  runWithContext,
  type UnitOfWorkContext,
} from '../../../shared/infra/db/unit-of-work.js';
import type { ConversationScope } from '../../domain/conversation-actor.js';

// Contexto do RLS de uma chamada: a organização e exatamente um principal (o outro vai vazio, para um contexto de fora
// não somar acesso). Dentro de um `UnitOfWork.run`, entra na transação ativa num savepoint e restaura o contexto
// anterior ao sair; fora, abre a própria transação.
export function scopeContext(scope: ConversationScope): UnitOfWorkContext {
  return scope.actor.kind === 'user'
    ? {
        organizationId: scope.organizationId,
        userId: scope.actor.userId,
        hubId: '',
      }
    : {
        organizationId: scope.organizationId,
        hubId: scope.actor.hubId,
        userId: '',
      };
}

export function inScope<T>(
  dataSource: DataSource,
  scope: ConversationScope,
  work: (manager: EntityManager) => Promise<T>,
): Promise<T> {
  return runWithContext(dataSource, scopeContext(scope), work);
}

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

// No driver pg, o `query` do TypeORM devolve `[rows, rowCount]` para UPDATE/DELETE e só `rows` para o resto.
export function updatedRows<T>(raw: unknown): T[] {
  return (raw as [T[], number])[0];
}
