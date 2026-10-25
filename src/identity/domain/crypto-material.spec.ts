import { DomainValidationError } from '../../shared/domain/errors.js';
import {
  assertAuthProof,
  assertEncryptedPrivateKey,
  assertKdfSalt,
  assertPublicKey,
} from './crypto-material.js';

const b64 = (bytes: Buffer) => bytes.toString('base64url');
const rand = (n: number) => Buffer.alloc(n, 0xab);
const epk = (n: number, first = 0x01) => {
  const b = Buffer.alloc(n, 0xcd);
  b[0] = first;
  return b64(b);
};

const cases = [
  ['assertKdfSalt', assertKdfSalt, 16, 'kdf-salt-invalid'],
  ['assertPublicKey', assertPublicKey, 32, 'public-key-invalid'],
  ['assertAuthProof', assertAuthProof, 32, 'auth-proof-invalid'],
] as const;

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DomainValidationError);
    expect((e as DomainValidationError).code).toBe(code);
    return;
  }
  throw new Error('did not throw');
}

describe.each(cases)('%s', (_name, fn, size, code) => {
  it('accepts the right size and returns the string', () => {
    const s = b64(rand(size));
    expect(fn(s)).toBe(s);
  });
  it('rejects wrong size', () => {
    expectCode(() => fn(b64(rand(size + 1))), code);
    expectCode(() => fn(b64(rand(size - 1))), code);
  });
  it('rejects padding, +, / and empty', () => {
    expectCode(() => fn(rand(size).toString('base64')), code);
    expectCode(() => fn(b64(rand(size)) + '='), code);
    expectCode(() => fn(b64(rand(size)).slice(0, -1) + '+'), code);
    expectCode(() => fn(b64(rand(size)).slice(0, -1) + '/'), code);
    expectCode(() => fn(''), code);
  });
  it('rejects non-canonical trailing bits', () => {
    const s = b64(rand(size));
    // last char with nonzero unused bits re-encodes differently
    const tweaked = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    if (Buffer.from(tweaked, 'base64url').toString('base64url') !== tweaked) {
      expectCode(() => fn(tweaked), code);
    }
  });
  it('rejects non-strings', () => {
    expectCode(() => fn(undefined as unknown as string), code);
  });
});

describe('assertEncryptedPrivateKey', () => {
  const code = 'encrypted-private-key-invalid';
  it('accepts 73 bytes with version 0x01', () => {
    const s = epk(73);
    expect(assertEncryptedPrivateKey(s)).toBe(s);
  });
  it('rejects wrong size, version 0x02, padding and empty', () => {
    expectCode(() => assertEncryptedPrivateKey(epk(72)), code);
    expectCode(() => assertEncryptedPrivateKey(epk(74)), code);
    expectCode(() => assertEncryptedPrivateKey(epk(73, 0x02)), code);
    expectCode(() => assertEncryptedPrivateKey(epk(73) + '='), code);
    expectCode(() => assertEncryptedPrivateKey(''), code);
  });
});
