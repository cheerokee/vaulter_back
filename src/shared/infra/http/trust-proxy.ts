import { isIP } from 'node:net';

function isIpOrCidr(item: string): boolean {
  const [addr, prefix, ...rest] = item.split('/');
  if (rest.length > 0 || !addr) return false;
  const version = isIP(addr);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

/**
 * Parses TRUST_PROXY into the value Express expects for the 'trust proxy' setting:
 * `false` (default), `true`, a hop count, or a list of IPs/CIDRs. Throws on anything else.
 */
export function parseTrustProxy(
  raw: string | undefined,
): boolean | number | string[] {
  const value = (raw ?? '').trim();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  const items = value.split(',').map((i) => i.trim());
  if (!items.every(isIpOrCidr)) {
    throw new Error(
      'TRUST_PROXY must be false, true, a hop count or a comma-separated list of IPs/CIDRs',
    );
  }
  return items;
}
