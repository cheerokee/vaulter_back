import { isIP } from 'node:net';

function isIpOrCidr(item: string): boolean {
  const [addr, prefix, ...rest] = item.split('/');
  if (rest.length > 0 || !addr) return false;
  if (addr.includes('%')) return false; // zone ids are not valid in trust proxy
  const version = isIP(addr);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^(0|[1-9]\d{0,2})$/.test(prefix)) return false;
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

export interface TrustProxyContext {
  nodeEnv: string | undefined;
  rateLimitEnabled: boolean;
  trustProxy: boolean | number | string[];
}

const MATCH_ALL_CIDRS = new Set(['0.0.0.0/0', '::/0']);

/** Boot-time warnings about a TRUST_PROXY value that is unsafe or breaks per-IP rate limits. */
export function trustProxyWarnings(ctx: TrustProxyContext): string[] {
  const out: string[] = [];
  const { trustProxy } = ctx;
  if (
    trustProxy === false &&
    ctx.nodeEnv === 'production' &&
    ctx.rateLimitEnabled
  ) {
    out.push(
      'TRUST_PROXY=false in production: behind a load balancer or reverse proxy every client shares the proxy IP, so per-IP rate limits become global. Set TRUST_PROXY to the hop count or the proxy CIDRs.',
    );
  }
  if (
    trustProxy === true ||
    (Array.isArray(trustProxy) &&
      trustProxy.some((i) => MATCH_ALL_CIDRS.has(i)))
  ) {
    out.push(
      'TRUST_PROXY trusts every X-Forwarded-For hop (true or a match-all CIDR): clients can forge their IP, bypass per-IP rate limits and spoof session IPs. Use the hop count or the proxy CIDRs instead.',
    );
  }
  return out;
}
