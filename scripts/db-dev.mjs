// `pnpm db:migrate | db:seed | db:seed:documents [alias] [count]`: runs the matching apps/api
// script with the development database variables filled in (see dev-env.mjs).
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describeDbTarget, devDbEnv } from './dev-env.mjs';
import { pnpmCommand } from './dev-api.mjs';

export const DB_COMMANDS = new Set(['migrate', 'seed', 'seed:documents']);

/** Arguments for pnpm, or throws on a command we do not know. */
export function dbArgs(argv) {
  const [name, ...rest] = argv;
  if (!DB_COMMANDS.has(name)) {
    throw new Error(`Usage: pnpm db:migrate | db:seed | db:seed:documents [acme|globex] [count]`);
  }
  return ['--filter', 'api', `db:${name}`, ...rest];
}

function main() {
  const execPath = process.env.npm_execpath;
  if (!execPath) {
    console.error('Run it as: pnpm db:migrate (or db:seed, db:seed:documents)');
    process.exit(1);
  }
  let env;
  let args;
  try {
    env = devDbEnv(process.env);
    args = dbArgs(process.argv.slice(2));
    // Named before anything runs, so a script pointed at the wrong database is noticed.
    console.error(`db: ${describeDbTarget(process.env, env)}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { command, args: base } = pnpmCommand(execPath);
  const child = spawn(command, [...base, ...args], { env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
