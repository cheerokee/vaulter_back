import { normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail(' Ana@X.COM ')).toBe('ana@x.com');
  });
});
