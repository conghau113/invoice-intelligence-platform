// Database variables for local development, shared by `pnpm dev:api`, `pnpm dev:worker` and
// `pnpm db:migrate|db:seed|db:seed:documents`. Nothing here is a secret: the owner default is read
// from compose.yaml, where the throw-away development database is defined (this file repeats no
// password), and the app role's default is that value plus "-app". Anything set in the shell
// wins, so a developer who changed a password keeps working.
import { readFileSync } from 'node:fs';

const COMPOSE_FILE = new URL('../compose.yaml', import.meta.url);
const COMPOSE_MARKER = 'POSTGRES_PASSWORD:-';

/** The default compose.yaml gives the owner: the text after `POSTGRES_PASSWORD:-` up to the closing brace. */
export function composeOwnerDefault(text = readFileSync(COMPOSE_FILE, 'utf8')) {
  const start = text.indexOf(COMPOSE_MARKER);
  const end = start < 0 ? -1 : text.indexOf('}', start);
  if (start < 0 || end < 0 || end === start + COMPOSE_MARKER.length) {
    throw new Error(
      'compose.yaml has no default for POSTGRES_PASSWORD: set the database variables yourself',
    );
  }
  return text.slice(start + COMPOSE_MARKER.length, end).trim();
}

/** Default for the `invoice_app` role: development only, derived so no second copy is committed. */
export const defaultAppDbPassword = (ownerDefault = composeOwnerDefault()) => `${ownerDefault}-app`;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const hostOf = (url) => {
  try {
    return new URL(url).hostname; // WHATWG gives "[::1]" for IPv6 loopback
  } catch {
    return undefined;
  }
};

/**
 * One line saying which database a script is about to touch and whether the committed default
 * app password is in play. No credentials: host, port, database name only.
 */
export function describeDbTarget(before, after) {
  let where = 'unknown database';
  try {
    const u = new URL(after.DATABASE_OWNER_URL);
    where = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    // keep the placeholder
  }
  const password = before.APP_DB_PASSWORD
    ? 'APP_DB_PASSWORD from your shell'
    : 'the committed dev-only default app password';
  return `database ${where}; role invoice_app will use ${password}`;
}

/**
 * The environment with the database variables filled in. Throws when it is not safe to guess:
 * a non-development NODE_ENV, or a database on another machine without an explicit app password
 * (migrating would otherwise set that database's app role to the well-known default).
 */
export function devDbEnv(env) {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development') {
    throw new Error(`This is for local development only (NODE_ENV=${env.NODE_ENV})`);
  }
  const merged = { ...env };
  for (const name of ['DATABASE_OWNER_URL', 'DATABASE_URL']) {
    const host = merged[name] === undefined ? 'localhost' : hostOf(merged[name]);
    if (!LOCAL_HOSTS.has(host) && !merged.APP_DB_PASSWORD) {
      throw new Error(
        `${name} points at another machine: set APP_DB_PASSWORD explicitly (no default is used there)`,
      );
    }
  }
  const ownerDefault = composeOwnerDefault();
  merged.APP_DB_PASSWORD ||= defaultAppDbPassword(ownerDefault);

  const user = merged.POSTGRES_USER || 'invoice';
  const ownerPassword = merged.POSTGRES_PASSWORD || ownerDefault;
  const db = merged.POSTGRES_DB || 'invoice';
  const port = merged.POSTGRES_PORT || '5433'; // host port of compose.yaml
  const enc = encodeURIComponent;
  merged.DATABASE_OWNER_URL ??= `postgres://${enc(user)}:${enc(ownerPassword)}@localhost:${port}/${db}`;
  merged.DATABASE_URL ??= `postgres://invoice_app:${enc(merged.APP_DB_PASSWORD)}@localhost:${port}/${db}`;
  return merged;
}
