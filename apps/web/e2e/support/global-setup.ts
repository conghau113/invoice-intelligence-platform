const ISSUER = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8080/realms/invoice';
const API = 'http://localhost:3001';
const WEB = 'http://localhost:3000';

async function reachable(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { signal: AbortSignal.timeout(5_000) })).ok;
  } catch {
    return false;
  }
}

/**
 * Fails the run with one clear message when a dependency is down, instead of 30 timeouts that
 * look like product bugs. The web and API are started by Playwright in CI (webServer), so by the
 * time this runs they are expected; Keycloak is always external.
 */
export default async function globalSetup(): Promise<void> {
  const checks: Array<[string, string, string]> = [
    ['Keycloak', `${ISSUER}/.well-known/openid-configuration`, 'pnpm infra:up'],
    ['API', `${API}/health/ready`, 'pnpm dev:api'],
    ['Web', `${WEB}/api/health`, 'pnpm --filter web dev'],
  ];
  const results = await Promise.all(
    checks.map(async ([name, url, fix]) =>
      (await reachable(url)) ? null : `${name} (${url}) is not reachable: run \`${fix}\``,
    ),
  );
  const down = results.filter((r): r is string => r !== null);
  if (down.length > 0) throw new Error(`E2E prerequisites missing:\n- ${down.join('\n- ')}`);
}
