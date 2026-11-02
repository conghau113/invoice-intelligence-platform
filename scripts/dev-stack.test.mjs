import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { busyServices, linePrefixer, portInUse, runStack, waitReady } from './dev-stack.mjs';

const node = process.execPath;
const SLEEP = 'setInterval(() => {}, 1000)';
// A service that leaves a grandchild behind, like pnpm leaves the real server: prints its pid.
const WITH_GRANDCHILD = `const c = require('node:child_process').spawn(process.execPath, ['-e', '${SLEEP}'], { stdio: 'ignore' });
console.log('GC ' + c.pid); ${SLEEP}`;

const sink = () => {
  const lines = [];
  return { lines, write: (s) => lines.push(s) };
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const grandchildPid = (lines) => Number(lines.join('').match(/GC (\d+)/)?.[1]);
const until = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end && !cond()) await new Promise((r) => setTimeout(r, 25));
};

test('linePrefixer: prefixes whole lines, joins a line split across chunks, flushes the tail', () => {
  const out = [];
  const p = linePrefixer('[x]', (l) => out.push(l));
  p.push('one\ntw');
  p.push('o\r\nthr');
  p.push('ee');
  assert.deepEqual(out, ['[x] one\n', '[x] two\n']);
  p.flush();
  assert.deepEqual(out, ['[x] one\n', '[x] two\n', '[x] three\n']);
  p.flush(); // nothing left: no empty line
  assert.equal(out.length, 3);
});

test('portInUse / busyServices: see a real listener and a free port', async () => {
  const server = net.createServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  assert.equal(await portInUse(port), true);
  assert.deepEqual(
    (await busyServices([{ name: 'a', port }, { name: 'noport' }])).map((s) => s.name),
    ['a'],
  );
  await new Promise((r) => server.close(r));
  assert.equal(await portInUse(port), false);
  assert.deepEqual(await busyServices([{ name: 'a', port }]), []);
});

test(
  'runStack: one service dying stops the others, grandchildren included, and fails the run',
  { timeout: 20_000 },
  async () => {
    const out = sink();
    const code = await runStack(
      [
        { name: 'big', command: node, args: ['-e', WITH_GRANDCHILD] },
        { name: 'dies', command: node, args: ['-e', 'setTimeout(() => process.exit(3), 500)'] },
      ],
      { out, signals: new EventEmitter(), graceMs: 3000 },
    );
    const text = out.lines.join('');
    assert.equal(code, 1);
    assert.match(text, /\[big\]\x1b\[0m GC \d+/); // its output is prefixed
    assert.match(text, /\[stack\] dies exited \(3\); stopping everything/);
    assert.equal(
      alive(grandchildPid(out.lines)),
      false,
      'the grandchild must not outlive the stack',
    );
  },
);

test(
  'runStack: an interrupt stops everything and is a clean exit',
  { timeout: 20_000 },
  async () => {
    const out = sink();
    const signals = new EventEmitter();
    const done = runStack([{ name: 'big', command: node, args: ['-e', WITH_GRANDCHILD] }], {
      out,
      signals,
      graceMs: 3000,
    });
    await until(() => Number.isInteger(grandchildPid(out.lines)));
    const pid = grandchildPid(out.lines);
    assert.equal(alive(pid), true);
    signals.emit('SIGINT');
    assert.equal(await done, 0);
    assert.equal(alive(pid), false);
  },
);

test(
  'runStack: a service that ignores SIGTERM is killed after the grace period',
  { timeout: 20_000 },
  async () => {
    const out = sink();
    const signals = new EventEmitter();
    const stubborn = `process.on('SIGTERM', () => {}); console.log('GC ' + process.pid); ${SLEEP}`;
    const done = runStack([{ name: 'stubborn', command: node, args: ['-e', stubborn] }], {
      out,
      signals,
      graceMs: 300,
    });
    await until(() => Number.isInteger(grandchildPid(out.lines)));
    const pid = grandchildPid(out.lines);
    signals.emit('SIGINT');
    assert.equal(await done, 0);
    assert.equal(alive(pid), false);
  },
);

test('runStack: a command that cannot start fails the run', { timeout: 20_000 }, async () => {
  const out = sink();
  const code = await runStack([{ name: 'ghost', command: '/definitely/not/a/binary', args: [] }], {
    out,
    signals: new EventEmitter(),
    graceMs: 500,
  });
  assert.equal(code, 1);
  assert.match(out.lines.join(''), /could not start/);
});

test('waitReady: reports each service once it answers 2xx and returns those still down', async () => {
  const ready = [];
  let calls = 0;
  const fetchFn = async (url) => {
    calls += 1;
    if (url.endsWith('/up')) return { ok: true };
    if (url.endsWith('/late')) return { ok: calls > 3 };
    throw new Error('refused');
  };
  const left = await waitReady(
    [
      { name: 'up', url: 'x://h/up' },
      { name: 'late', url: 'x://h/late' },
      { name: 'down', url: 'x://h/down' },
    ],
    { timeoutMs: 400, intervalMs: 20, onReady: (n) => ready.push(n), fetchFn },
  );
  assert.deepEqual(ready, ['up', 'late']);
  assert.deepEqual(left, ['down']);
});
