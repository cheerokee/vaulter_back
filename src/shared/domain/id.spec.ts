import { v4 } from 'uuid';
import { isUuidV7, newId } from './id.js';

describe('id', () => {
  it('generates uuid v7 ids', () => {
    expect(isUuidV7(newId())).toBe(true);
  });

  it('generates ids in time order', () => {
    const a = newId();
    const b = newId();
    expect(a < b).toBe(true);
  });

  it('rejects non v7 values', () => {
    expect(isUuidV7(v4())).toBe(false);
    expect(isUuidV7('not-a-uuid')).toBe(false);
  });
});
