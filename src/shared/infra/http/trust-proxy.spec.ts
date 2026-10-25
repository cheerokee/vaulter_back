import { parseTrustProxy, trustProxyWarnings } from './trust-proxy.js';

describe('parseTrustProxy', () => {
  it('defaults to false', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
  });

  it.each([
    ['false', false],
    ['true', true],
    ['1', 1],
    ['3', 3],
    ['0', 0],
  ])('parses %s', (raw, expected) => {
    expect(parseTrustProxy(raw)).toBe(expected);
  });

  it('parses a list of IPs and CIDRs, trimming spaces', () => {
    expect(parseTrustProxy('10.0.0.0/8, 127.0.0.1')).toEqual([
      '10.0.0.0/8',
      '127.0.0.1',
    ]);
    expect(parseTrustProxy('::1,fd00::/8')).toEqual(['::1', 'fd00::/8']);
  });

  it.each([
    'yes',
    '-1',
    '1.5',
    '10.0.0.0/33',
    '999.1.1.1',
    '10.0.0.1,,',
    'loopback; drop',
    '10.0.0.1,abc',
    'fd00::/129',
    '10.0.0.0/08',
    '10.0.0.0/001',
    'fe80::1%eth0',
    'fe80::1%eth0/64',
  ])('rejects %s', (raw) => {
    expect(() => parseTrustProxy(raw)).toThrow();
  });
});

describe('trustProxyWarnings', () => {
  const base = { nodeEnv: 'production', rateLimitEnabled: true };

  it('warns that false behind a load balancer collapses every client into one IP (production + rate limit)', () => {
    const w = trustProxyWarnings({ ...base, trustProxy: false });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/TRUST_PROXY=false/);
  });

  it('stays quiet for false outside production or with rate limit off', () => {
    expect(
      trustProxyWarnings({
        ...base,
        nodeEnv: 'development',
        trustProxy: false,
      }),
    ).toEqual([]);
    expect(
      trustProxyWarnings({
        ...base,
        rateLimitEnabled: false,
        trustProxy: false,
      }),
    ).toEqual([]);
  });

  it('warns about true and match-everything CIDRs in any environment', () => {
    for (const nodeEnv of ['production', 'development', undefined]) {
      expect(
        trustProxyWarnings({ ...base, nodeEnv, trustProxy: true }),
      ).toHaveLength(1);
    }
    expect(
      trustProxyWarnings({ ...base, trustProxy: ['0.0.0.0/0'] }),
    ).toHaveLength(1);
    expect(trustProxyWarnings({ ...base, trustProxy: ['::/0'] })).toHaveLength(
      1,
    );
  });

  it('accepts hop counts and specific proxy lists', () => {
    expect(trustProxyWarnings({ ...base, trustProxy: 1 })).toEqual([]);
    expect(
      trustProxyWarnings({ ...base, trustProxy: ['10.0.0.0/8', '127.0.0.1'] }),
    ).toEqual([]);
  });
});
