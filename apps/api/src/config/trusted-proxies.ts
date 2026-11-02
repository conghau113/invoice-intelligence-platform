import { isIP } from 'node:net';

const NAMED = new Set(['loopback', 'linklocal', 'uniquelocal']);

/**
 * The caller address for an audit row, or undefined when `req.ip` is not an IP address. With a
 * trusted proxy `req.ip` comes from a header, and a header can hold anything: the audit column is
 * `inet`, so a bad value would fail the insert (and the upload) instead of being recorded.
 */
export function auditIp(ip: string | undefined): string | undefined {
  return ip !== undefined && isIP(ip) !== 0 ? ip : undefined;
}

/**
 * Checks the value of TRUSTED_PROXIES: a comma-separated list of Express "trust proxy" entries,
 * each a name (loopback, linklocal, uniquelocal), an IP address, or a CIDR range. Anything that
 * would trust every client is refused on purpose: `true`, a hop count, or a /0 range. With such a
 * value any caller could put a made-up address into X-Forwarded-For and into the audit log.
 * Returns the reason it is invalid, or null.
 */
export function trustedProxiesProblem(value: string): string | null {
  const entries = value.split(',').map((e) => e.trim());
  for (const entry of entries) {
    if (entry === '') return 'must not contain an empty entry';
    if (NAMED.has(entry)) continue;
    const [address, prefix, ...rest] = entry.split('/');
    const family = isIP(address ?? '');
    if (family === 0 || rest.length > 0) {
      return 'entries must be loopback, linklocal, uniquelocal, an IP address or a CIDR range';
    }
    if (prefix !== undefined) {
      const bits = Number(prefix);
      const max = family === 4 ? 32 : 128;
      if (!/^\d{1,3}$/.test(prefix) || bits < 1 || bits > max) {
        return 'a CIDR prefix must be between 1 and the address size (a /0 range trusts everyone)';
      }
    }
  }
  return null;
}
