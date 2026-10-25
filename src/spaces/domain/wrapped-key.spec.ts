import { DomainValidationError } from '../../shared/domain/errors.js';
import { assertWrappedSpaceKey } from './wrapped-key.js';
import {
  generateSpaceKey,
  recoveryKitKeypair,
  sealSpaceKey,
} from '../../../test/support/client-crypto.js';

const enc = (b: Buffer) => b.toString('base64url');
const valid = () => {
  const b = Buffer.alloc(81, 7);
  b[0] = 1;
  return b;
};

describe('assertWrappedSpaceKey', () => {
  it('accepts a real sealed copy', async () => {
    const pair = await recoveryKitKeypair();
    const wrapped = await sealSpaceKey(
      await generateSpaceKey(),
      pair.publicKey,
    );
    expect(assertWrappedSpaceKey(wrapped)).toBe(wrapped);
  });

  it.each([
    ['too short', enc(valid().subarray(0, 80))],
    ['too long', enc(Buffer.concat([valid(), Buffer.from([1])]))],
    ['version 2', enc(Buffer.concat([Buffer.from([2]), valid().subarray(1)]))],
    ['padding', enc(valid()) + '='],
    ['plus', enc(valid()).slice(0, 107) + '+'],
    ['slash', enc(valid()).slice(0, 107) + '/'],
    ['empty', ''],
    ['non string', 42 as unknown as string],
  ])('rejects %s', (_n, value) => {
    expect(() => assertWrappedSpaceKey(value)).toThrow(DomainValidationError);
    try {
      assertWrappedSpaceKey(value);
    } catch (e) {
      expect((e as DomainValidationError).code).toBe('wrapped-key-invalid');
    }
  });
});
