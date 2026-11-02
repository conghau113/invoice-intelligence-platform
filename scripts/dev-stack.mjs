// `pnpm dev:stack`: the whole local stack from one terminal. Starts the infrastructure
// (Postgres, Redis, Keycloak), applies pending migrations, then runs AI, API, worker and web, each
// line of output prefixed with the service name. Ctrl+C (or any service dying) stops all of them.
//
// Each service runs in its own process group, because pnpm starts the real server as a
// grandchild: signalling only the pnpm process leaves that server alive and holding its port (the
// cause of an EADDRINUSE on the next start). The group is signalled instead, so nothing is left.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { pnpmCommand } from './dev-api.mjs';

export const SERVICES = [
  { name: 'ai', args: ['dev:ai'], port: 8000, health: '/health' },
  { name: 'api', args: ['dev:api'], port: 3001, health: '/health/ready' },
  { name: 'worker', args: ['dev:worker'] },
  { name: 'web', args: ['--filter', 'web', 'dev'], port: 3000, health: '/api/health' },
];

const COLORS = [36, 33, 35, 32, 34]; // ANSI foreground colours, one per service

/** Splits a stream into lines (chunks may end mid-line) and writes each with `prefix`. */
export function linePrefixer(prefix, write) {
  let rest = '';
  return {
    push(chunk) {
      const parts = (rest + chunk).split(/\r?\n/);
      rest = parts.pop() ?? '';
      for (const line of parts) write(`${prefix} ${line}\n`);
    },
    flush() {
      if (rest !== '') write(`${prefix} ${rest}\n`);
      rest = '';
    },
  };
}

/** True when something already accepts connections on the port (on this machine). */
export function portInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

/** The services whose port is already taken: starting them would only fail with EADDRINUSE. */
export async function busyServices(services) {
  const busy = [];
  for (const s of services) if (s.port !== undefined && (await portInUse(s.port))) busy.push(s);
  return busy;
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal); // negative pid = the whole process group
  } catch {
    // already gone
  }
}

function groupAlive(child) {
  try {
    process.kill(-child.pid, 0); // signal 0 only checks that the group still has members
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs the services until Ctrl+C or until one of them exits, then stops all of them (SIGTERM to
 * every group, SIGKILL after `graceMs`). Resolves with the exit code: 0 on a requested stop, 1 when
 * a service died by itself.
 * @param {Array<{name: string, command: string, args: string[], env?: object}>} services
 */
export function runStack(
  services,
  { graceMs = 5000, out = process.stdout, signals = process } = {},
) {
  return new Promise((resolve) => {
    const children = [];
    let stopping = false;
    let code = 0;
    let alive = services.length;

    const stopAll = (reason) => {
      if (stopping) return;
      stopping = true;
      out.write(`[stack] ${reason}; stopping everything\n`);
      for (const c of children) signalGroup(c, 'SIGTERM');
      const timer = setTimeout(() => {
        for (const c of children) signalGroup(c, 'SIGKILL');
      }, graceMs);
      timer.unref();
    };

    // One service is fully gone (its whole group, or it never started): done when all are.
    const finish = () => {
      alive -= 1;
      if (alive === 0) {
        signals.off('SIGINT', onSignal);
        signals.off('SIGTERM', onSignal);
        resolve(code);
      }
    };

    const onSignal = () => stopAll('interrupted');
    signals.once('SIGINT', onSignal);
    signals.once('SIGTERM', onSignal);

    services.forEach((s, i) => {
      const color = COLORS[i % COLORS.length];
      const prefix = `\x1b[${color}m[${s.name}]\x1b[0m`;
      const child = spawn(s.command, s.args, {
        env: { ...process.env, FORCE_COLOR: '1', ...s.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true, // own process group (see the header)
      });
      children.push(child);
      const stdout = linePrefixer(prefix, (l) => out.write(l));
      const stderr = linePrefixer(prefix, (l) => out.write(l));
      child.stdout.setEncoding('utf8').on('data', stdout.push);
      child.stderr.setEncoding('utf8').on('data', stderr.push);
      child.on('error', () => {
        // Only a failed spawn matters here (no pid, and no 'exit' will ever follow).
        if (child.pid !== undefined) return;
        out.write(`${prefix} could not start\n`);
        code = 1;
        stopAll(`${s.name} could not start`);
        finish();
      });
      child.on('exit', (exitCode, signal) => {
        stdout.flush();
        stderr.flush();
        if (!stopping) {
          code = 1;
          stopAll(`${s.name} exited (${exitCode ?? signal})`);
        }
        // The leader is gone but its grandchildren (the real server) may still be shutting down,
        // e.g. the worker finishing a job. Done only when the whole group is empty; the SIGKILL
        // timer in stopAll ends a group that will not leave.
        const wait = setInterval(() => {
          if (groupAlive(child)) return;
          clearInterval(wait);
          finish();
        }, 100);
      });
    });
  });
}

/** Polls each URL until it answers 2xx; calls `onReady(name)` once per service. Gives up quietly. */
export async function waitReady(
  checks,
  { timeoutMs = 180_000, intervalMs = 1000, onReady, fetchFn = fetch } = {},
) {
  const pending = new Map(checks.map((c) => [c.name, c.url]));
  const until = Date.now() + timeoutMs;
  while (pending.size > 0 && Date.now() < until) {
    for (const [name, url] of pending) {
      try {
        const res = await fetchFn(url, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          pending.delete(name);
          onReady(name);
        }
      } catch {
        // not up yet
      }
    }
    if (pending.size > 0) await new Promise((r) => setTimeout(r, intervalMs));
  }
  return [...pending.keys()];
}

function runOnce(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => resolve(1));
    child.on('exit', (c) => resolve(c ?? 1));
  });
}

async function main() {
  const execPath = process.env.npm_execpath;
  if (!execPath) {
    console.error('Run it as: pnpm dev:stack');
    process.exit(1);
  }
  const { command, args } = pnpmCommand(execPath);

  const busy = await busyServices(SERVICES);
  if (busy.length > 0) {
    for (const s of busy) console.error(`[stack] port ${s.port} (${s.name}) is already in use`);
    console.error('Stop what is running there first: ss -ltnp | grep :<port>, then kill <pid>.');
    process.exit(1);
  }

  for (const step of [['infra:up'], ['db:migrate']]) {
    console.log(`[stack] pnpm ${step.join(' ')}`);
    if ((await runOnce(command, [...args, ...step])) !== 0) {
      console.error(`[stack] "pnpm ${step.join(' ')}" failed; not starting the services`);
      process.exit(1);
    }
  }

  const services = SERVICES.map((s) => ({ name: s.name, command, args: [...args, ...s.args] }));
  const checks = SERVICES.filter((s) => s.port !== undefined).map((s) => ({
    name: s.name,
    url: `http://localhost:${s.port}${s.health}`,
  }));
  void waitReady(checks, {
    onReady: (name) => console.log(`[stack] ${name} is ready`),
  }).then((left) => {
    if (left.length === 0) console.log('[stack] all ready: web http://localhost:3000/vi/login');
    else console.log(`[stack] still not ready after waiting: ${left.join(', ')}`);
  });
  process.exit(await runStack(services));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
