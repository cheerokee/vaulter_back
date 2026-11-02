import { DomainValidationError } from './errors.js';
import { newId } from './id.js';
import { decodeCursor, encodeCursor, pageFrom } from './pagination.js';

describe('pagination cursor', () => {
  it('round-trips an id', () => {
    const id = newId();
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it('normalizes an uppercase id to lowercase (JS string comparisons never skip or repeat)', () => {
    const id = newId();
    const upper = encodeCursor(id.toUpperCase());
    expect(decodeCursor(upper)).toBe(id);
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('%%%')).toThrow(DomainValidationError);
  });

  it('rejects a cursor that is not a uuid', () => {
    const cursor = Buffer.from('hello').toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow(DomainValidationError);
  });
});

describe('pageFrom', () => {
  it('cuts limit + 1 rows to limit and points the cursor at the last item', () => {
    const [a, b, c] = [newId(), newId(), newId()];
    expect(pageFrom([a, b, c], 2, (x) => x)).toEqual({
      items: [a, b],
      nextCursor: encodeCursor(b),
    });
    expect(pageFrom([a, b], 2, (x) => x)).toEqual({
      items: [a, b],
      nextCursor: null,
    });
    expect(pageFrom([], 2, (x: string) => x)).toEqual({
      items: [],
      nextCursor: null,
    });
  });
});
