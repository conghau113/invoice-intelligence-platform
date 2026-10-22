// Starts the API (or, with the argument `worker`, the queue worker) for local development. The API reads no dotfile (ignoreEnvFile), so the variables
// it needs are put in its process environment here. Values already set in your shell win.
// The database variables come from dev-env.mjs (defaults = the throw-away passwords of compose.yaml).
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devDbEnv } from './dev-env.mjs';

export const DEV_DEFAULTS = {
  NODE_ENV: 'development',
  OIDC_ISSUER_URL: 'http://localhost:8080/realms/invoice',
  // <repo>/data is git-ignored; the API requires an absolute path.
  DATA_DIR: fileURLToPath(new URL('../data', import.meta.url)),
  // Redis of `pnpm infra:up` (compose.yaml, host port 6380, no password).
  REDIS_URL: 'redis://localhost:6380',
};

/** Environment for the API: dev defaults under whatever the caller already set. */
export function devApiEnv(env) {
  const merged = devDbEnv(env);
  for (const [name, value] of Object.entries(DEV_DEFAULTS)) merged[name] ??= value;
  return merged;
}

/** `pnpm dev:api` runs the HTTP API; `pnpm dev:worker` runs the queue worker with the same environment. */
export function devScript(target) {
  return target === 'worker' ? 'start:worker:dev' : 'start:dev';
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
    console.error('Run it as: pnpm dev:api (or pnpm dev:worker)');
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
  const child = spawn(command, [...args, '--filter', 'api', devScript(process.argv[2])], {
    env,
    stdio: 'inherit',
  });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
