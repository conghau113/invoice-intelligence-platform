// T6.7: run ONE service of the local stack for the failure drill, so each can be killed alone.
//
//   pnpm infra:up && pnpm db:migrate && pnpm --filter api build
//   node load/drill/service.mjs ai        # terminal 1
//   node load/drill/service.mjs api       # terminal 2
//   node load/drill/service.mjs worker    # terminal 3
//
// Same environment as load/k6/serve.mjs (built `dist/`, uvicorn without reload, always
// LLM_PROVIDER=fake: a drill never calls a model), but one process per call and no "stop all when
// one exits": killing one service is the point. This script waits for its child, exits with the
// child's code and passes SIGINT/SIGTERM on. Kill the child itself, found with
// `pgrep -f '[d]ist/worker.js'` or `pgrep -f '[u]vicorn app.main'` (README.md).
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { devApiEnv } from '../../scripts/dev-api.mjs';
import { devAiEnv } from '../../scripts/dev-ai.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const apiDir = `${root}apps/api`;
const aiDir = `${root}apps/ai`;
const uvicorn = `${aiDir}/.venv/bin/uvicorn`;

const name = process.argv[2];
const base = { ...process.env, LLM_PROVIDER: 'fake' };

let service;
try {
  if (name === 'ai') {
    service = {
      file: uvicorn,
      command: uvicorn,
      args: ['app.main:app', '--port', '8000'],
      cwd: aiDir,
      env: devAiEnv(base),
    };
  } else if (name === 'api' || name === 'worker') {
    const file = `${apiDir}/dist/${name === 'api' ? 'main' : 'worker'}.js`;
    service = {
      file,
      command: process.execPath,
      args: [file],
      cwd: apiDir,
      env: devApiEnv(base),
    };
  } else {
    console.error('usage: node load/drill/service.mjs <ai|api|worker>');
    process.exit(2);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

if (!existsSync(service.file)) {
  console.error(
    `Missing ${service.file}: run pnpm --filter api build (and pnpm install for apps/ai).`,
  );
  process.exit(1);
}

const child = spawn(service.command, service.args, {
  cwd: service.cwd,
  env: service.env,
  stdio: 'inherit',
});
console.error(`[drill] ${name} pid ${child.pid}`);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  console.error(`[drill] ${name} exited (${signal ?? code})`);
  process.exit(code ?? 1);
});
