/**
 * Shared by the T6.6 load scripts: who calls, with which token, in which tenant.
 *
 * `run.sh` signs in every dev-realm identity on the host (issuer `localhost:8080`, the one the
 * API accepts) and passes them as one JSON array in `IDENTITIES`. Each VU always speaks as the
 * same identity, chosen round-robin, so the load spreads evenly over the rate-limit buckets of
 * ADR 0012 (one bucket per tenant and user and route class). The consultant belongs to two
 * tenants and appears twice, selecting the tenant with `X-Tenant` (a selector among the token's
 * own tenants, never a grant).
 */
import { Counter } from 'k6/metrics';

export const API = __ENV.API_BASE_URL || 'http://localhost:3001';

/** @type {{ name: string, tenant: string, token: string, roles: string[] }[]} */
const ALL = JSON.parse(__ENV.IDENTITIES || '[]');
if (ALL.length === 0) throw new Error('Set IDENTITIES: run the scripts through load/k6/run.sh');

/** Identities allowed a permission (the viewer cannot upload, for one). */
export function identitiesWith(role) {
  return role ? ALL.filter((i) => i.roles.includes(role)) : ALL;
}

/** The identity of the current VU (VUs are numbered from 1). */
export function identityOf(list, vu) {
  return list[(vu - 1) % list.length];
}

export function headersOf(identity, extra = {}) {
  return { Authorization: `Bearer ${identity.token}`, 'X-Tenant': identity.tenant, ...extra };
}

/**
 * 429 counted apart from errors. A run meant to measure the backend must see none: a 429 is
 * answered before any database work, so it would make the latency look better than it is.
 */
export const rateLimited = new Counter('rate_limited');

/**
 * A uniform number in [0, 1) from k6's Web Crypto. Spreading the load needs no secret, but the
 * runs in docs/reports/load-test-v1.md used independent uniform draws, and this keeps that shape
 * without `Math.random()` (which static analysis flags as a weak generator).
 */
export function uniform() {
  // Four bytes, not one Uint32: k6 1.4.2 fills a Uint32Array with values below 256 (checked by
  // hand), which made every draw almost 0.
  const [a, b, c, d] = crypto.getRandomValues(new Uint8Array(4));
  return (a * 2 ** 24 + b * 2 ** 16 + c * 2 ** 8 + d) / 2 ** 32;
}

/** A whole number in [0, n). */
export function pick(n) {
  return Math.floor(uniform() * n);
}

/** Waits a random time in [min, max) seconds: the "think time" of someone reading the page. */
export function think(sleep, min, max) {
  sleep(min + uniform() * (max - min));
}
