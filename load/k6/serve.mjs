// T6.6: the local stack to load-test, without the file watchers of `pnpm dev:stack`.
//
//   pnpm infra:up && pnpm db:migrate && pnpm --filter api build
//   node load/k6/serve.mjs              # Ctrl+C stops all three
//   API_NODE_FLAGS=--prof node load/k6/serve.mjs   # V8 CPU profile of the API (see README)
//
// `nest start --watch`, `uvicorn --reload` and the Next dev server keep a few CPU cores busy on
// their own, which shows up as a tail of slow answers even with one request at a time. This runs
// the built API and worker (`dist/`) and uvicorn without reload, with the same development
// environment as `pnpm dev:api` / `pnpm dev:ai` (dev-api.mjs, dev-ai.mjs), and no web: k6 calls
// the API directly. The AI service always gets LLM_PROVIDER=fake, so a load run never calls a
// model; the worker's provider pacing (T6.2) is opened up unless set, since nothing real is paced.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { devApiEnv } from '../../scripts/dev-api.mjs';
import { devAiEnv } from '../../scripts/dev-ai.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const apiDir = `${root}apps/api`;
const aiDir = `${root}apps/ai`;
const uvicorn = `${aiDir}/.venv/bin/uvicorn`;

for (const file of [`${apiDir}/dist/main.js`, `${apiDir}/dist/worker.js`, uvicorn]) {
  if (!existsSync(file)) {
    console.error(`Missing ${file}: run pnpm --filter api build (and pnpm install for apps/ai).`);
    process.exit(1);
  }
}

const base = { ...process.env, LLM_PROVIDER: 'fake' };
base.LLM_RPM ??= '6000';
base.LLM_TPM ??= '100000000';
let apiEnv;
let aiEnv;
try {
  apiEnv = devApiEnv(base);
  aiEnv = devAiEnv(base);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

// Extra node flags for the API only, e.g. API_NODE_FLAGS=--prof to find where its CPU goes
// (NODE_OPTIONS refuses --prof). Split on spaces: flags, not a shell command.
const apiFlags = (process.env.API_NODE_FLAGS ?? '').split(' ').filter((f) => f.length > 0);

const services = [
  {
    name: 'ai',
    command: uvicorn,
    args: ['app.main:app', '--port', '8000'],
    cwd: aiDir,
    env: aiEnv,
  },
  {
    name: 'api',
    command: process.execPath,
    args: [...apiFlags, 'dist/main.js'],
    cwd: apiDir,
    env: apiEnv,
  },
  { name: 'worker', command: process.execPath, args: ['dist/worker.js'], cwd: apiDir, env: apiEnv },
];

const children = services.map((s) => {
  const child = spawn(s.command, s.args, {
    cwd: s.cwd,
    env: s.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (chunk) =>
    chunk
      .toString()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => `[${s.name}] ${line}\n`)
      .join('');
  child.stdout.on('data', (c) => process.stdout.write(prefix(c)));
  child.stderr.on('data', (c) => process.stderr.write(prefix(c)));
  child.on('exit', (code, signal) => {
    console.error(`[${s.name}] exited (${signal ?? code})`);
    stopAll();
  });
  return child;
});

let stopping = false;
function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
