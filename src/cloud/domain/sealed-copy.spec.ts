import { parseSealedCopy } from './sealed-copy.js';

const copy = (first = 0x01, len = 81) => {
  const b = Buffer.alloc(len, 0xab);
  b[0] = first;
  return b.toString('base64url');
};

describe('parseSealedCopy', () => {
  it('returns the sealed box without the version byte', () => {
    const box = parseSealedCopy(copy());
    expect(box).toHaveLength(80);
    expect(box[0]).toBe(0xab);
  });

  it.each([
    ['another version', copy(0x02)],
    ['too short', copy(0x01, 80)],
    ['too long', copy(0x01, 82)],
    ['not base64url', `${copy().slice(0, 107)}=`],
  ])('rejects %s with server-copy-invalid', (_label, value) => {
    expect(() => parseSealedCopy(value)).toThrow(
      expect.objectContaining({ code: 'server-copy-invalid' }),
    );
  });
});
