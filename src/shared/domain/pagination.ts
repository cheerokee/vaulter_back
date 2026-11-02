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

/** A slice of rows keyed by id, after `after` (exclusive), at most `limit` of them (asked to the database as limit + 1). */
export type KeysetSlice = { after?: string; limit: number };

/**
 * Cursor page from rows fetched with `limit + 1` (in key order): the extra row only tells that there is a next page;
 * the cursor is the key of the last returned item.
 */
export function pageFrom<T>(
  rows: T[],
  limit: number,
  keyOf: (row: T) => string,
): CursorPage<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor(keyOf(last)) : null,
  };
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
