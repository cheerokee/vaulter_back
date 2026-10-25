import { validate } from 'uuid';
import { DomainValidationError } from './errors.js';

export interface CursorPageRequest {
  cursor?: string;
  limit: number;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  const id = /^[A-Za-z0-9_-]+$/.test(cursor)
    ? Buffer.from(cursor, 'base64url').toString('utf8')
    : '';
  if (!validate(id)) {
    throw new DomainValidationError(
      'invalid-cursor',
      'The pagination cursor is invalid.',
    );
  }
  return id;
}
