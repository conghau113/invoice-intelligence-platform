// Starts the AI service for local development. Its token comes from the same default as the API
// and the worker (DEV_DEFAULTS in dev-api.mjs), so the three always agree. A value already in your
// shell wins, like for dev-api.mjs; the process environment also wins over apps/ai's own env file
// (pydantic-settings reads real environment variables before the file), so a token left there
// does not cause a mismatch.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DEV_DEFAULTS, pnpmCommand } from './dev-api.mjs';

/** Environment for the AI service: the shared dev token under whatever the caller already set. */
export function devAiEnv(env) {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development') {
    throw new Error(`This is for local development only (NODE_ENV=${env.NODE_ENV})`);
  }
  return { ...env, AI_SERVICE_TOKEN: env.AI_SERVICE_TOKEN ?? DEV_DEFAULTS.AI_SERVICE_TOKEN };
}

function main() {
  const execPath = process.env.npm_execpath;
  if (!execPath) {
    console.error('Run it as: pnpm dev:ai');
    process.exit(1);
  }
  let env;
  try {
    env = devAiEnv(process.env);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { command, args } = pnpmCommand(execPath);
  const child = spawn(command, [...args, '--filter', 'ai', 'dev'], { env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
