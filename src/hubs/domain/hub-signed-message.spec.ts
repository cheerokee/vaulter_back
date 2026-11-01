import {
  canonicalJson,
  HUB_SIGNATURE_WINDOW_MS,
  hubSignedBytes,
  isFreshHubTimestamp,
  isIsoUtcTimestamp,
} from './hub-signed-message.js';

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

describe('hub timestamps', () => {
  const now = new Date('2026-11-01T12:00:00.000Z');
  it('accepts ISO 8601 UTC instants only', () => {
    expect(isIsoUtcTimestamp('2026-11-01T12:00:00Z')).toBe(true);
    expect(isIsoUtcTimestamp('2026-11-01T12:00:00.123Z')).toBe(true);
    for (const bad of [
      '2026-11-01T12:00:00',
      '2026-11-01T12:00:00+00:00',
      '2026-11-01 12:00:00Z',
      '2026-13-01T12:00:00Z',
      '',
      1762000000000,
    ]) {
      expect(isIsoUtcTimestamp(bad)).toBe(false);
    }
  });

  it('is fresh within ±5 minutes, inclusive', () => {
    expect(HUB_SIGNATURE_WINDOW_MS).toBe(300_000);
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    expect(isFreshHubTimestamp(at(300_000), now)).toBe(true);
    expect(isFreshHubTimestamp(at(-300_000), now)).toBe(true);
    expect(isFreshHubTimestamp(at(300_001), now)).toBe(false);
    expect(isFreshHubTimestamp(at(-300_001), now)).toBe(false);
    expect(isFreshHubTimestamp('garbage', now)).toBe(false);
  });
});
