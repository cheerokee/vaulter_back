import { parseTrustProxy } from './trust-proxy.js';

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
