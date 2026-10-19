// Starts the API for local development. The API reads no dotfile (ignoreEnvFile), so the variables
// it needs are put in its process environment here. Values already set in your shell win.
// No password lives in this file: the database password comes from APP_DB_PASSWORD (the same
// variable db:migrate uses), exported once in your shell profile.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const DEV_DEFAULTS = {
  NODE_ENV: 'development',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/invoice',
};

/** Environment for the API: dev defaults under whatever the caller already set. */
export function devApiEnv(env) {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development') {
    throw new Error(`dev:api is for local development only (NODE_ENV=${env.NODE_ENV})`);
  }
  const merged = { ...env };
  for (const [name, value] of Object.entries(DEV_DEFAULTS)) merged[name] ??= value;
  if (merged.DATABASE_URL === undefined) {
    if (!merged.APP_DB_PASSWORD) {
      throw new Error('Set DATABASE_URL, or APP_DB_PASSWORD (password of the invoice_app role)');
    }
    const password = encodeURIComponent(merged.APP_DB_PASSWORD);
    merged.DATABASE_URL = `postgres://invoice_app:${password}@localhost:5433/invoice`;
  }
  return merged;
}

/** pnpm is a JS file on some installs and a native binary on others (pnpm 12 via corepack). */
export function pnpmCommand(execPath) {
  return /\.[cm]?js$/.test(execPath)
    ? { command: process.execPath, args: [execPath] }
    : { command: execPath, args: [] };
}

function main() {
  // Run through the same pnpm that launched this script, not a PATH lookup.
  const execPath = process.env.npm_execpath;
  if (!execPath) {
    console.error('Run it as: pnpm dev:api');
    process.exit(1);
  }
  const { command, args } = pnpmCommand(execPath);
  let env;
  try {
    env = devApiEnv(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const child = spawn(command, [...args, '--filter', 'api', 'start:dev'], {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
