import type { DataSource } from 'typeorm';
import { NotFoundError } from '../../../shared/domain/errors.js';
import { currentManager } from '../../../shared/infra/db/unit-of-work.js';

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

// Hub ausente ou invisível no contexto (sem dono/Hub/vínculo): erro de domínio, nunca um 500.
export function hubNotFound(): NotFoundError {
  return new NotFoundError('hub-not-found', 'The hub was not found.');
}

export function spaceNotFound(): NotFoundError {
  return new NotFoundError('space-not-found', 'The space was not found.');
}
