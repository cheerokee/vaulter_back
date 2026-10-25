import { DomainValidationError } from './errors.js';
import { newId } from './id.js';
import { decodeCursor, encodeCursor } from './pagination.js';

describe('pagination cursor', () => {
  it('round-trips an id', () => {
    const id = newId();
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it('rejects garbage', () => {
    expect(() => decodeCursor('%%%')).toThrow(DomainValidationError);
  });

  it('rejects a cursor that is not a uuid', () => {
    const cursor = Buffer.from('hello').toString('base64url');
    expect(() => decodeCursor(cursor)).toThrow(DomainValidationError);
  });
});
