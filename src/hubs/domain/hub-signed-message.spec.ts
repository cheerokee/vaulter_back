import { canonicalJson, hubSignedBytes } from './hub-signed-message.js';

describe('canonicalJson', () => {
  it('sorts keys recursively, without whitespace, regardless of input order', () => {
    const a = canonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 'x' } });
    const b = canonicalJson({ a: { c: 'x', d: [{ y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe('{"a":{"c":"x","d":[{"y":2,"z":1}]},"b":1}');
    expect(b).toBe(a);
  });

  it('builds label || 0x00 || canonical JSON in UTF-8', () => {
    const bytes = hubSignedBytes('l', { b: 'é', a: 1 });
    expect(Buffer.from(bytes).toString('hex')).toBe(
      '6c00' + Buffer.from('{"a":1,"b":"é"}').toString('hex'),
    );
  });
});
