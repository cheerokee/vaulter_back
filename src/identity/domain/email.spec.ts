import { DomainValidationError } from '../../shared/domain/errors.js';
import { assertEmailLength, normalizeEmail } from './email.js';

describe('normalizeEmail', () => {
  it('trims and lowercases', () => {
    expect(normalizeEmail(' Ana@X.COM ')).toBe('ana@x.com');
  });

  it('applies NFC so composed and decomposed forms are equal', () => {
    expect(normalizeEmail('jose\u0301@x.com')).toBe(
      normalizeEmail('jos\u00e9@x.com'),
    );
    expect(normalizeEmail('jose\u0301@x.com')).toBe('jos\u00e9@x.com');
  });

  it('can grow when lowercased (dotted capital I)', () => {
    expect(normalizeEmail('\u0130'.repeat(3)).length).toBe(6);
  });
});

describe('assertEmailLength', () => {
  it('accepts 1..255 characters', () => {
    expect(assertEmailLength('a'.repeat(255))).toBe('a'.repeat(255));
    expect(assertEmailLength('a')).toBe('a');
  });

  it.each(['', 'a'.repeat(256), '\u0130'.repeat(135).toLowerCase()])(
    'rejects length %#',
    (v) => {
      expect(() => assertEmailLength(v)).toThrow(DomainValidationError);
    },
  );
});
