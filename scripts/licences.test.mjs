// The licence gate runs for real on committed fixtures: a good inventory passes, a bad one names
// each problem and exits 1 (T7.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  checkLicences,
  isAllowed,
  normalize,
  parseSpdx,
  pythonExpression,
  pyName,
  renderGenerated,
} from './licences.mjs';

const fixtures = path.join(import.meta.dirname, '__fixtures__', 'licences');

function gate(fixture) {
  const root = path.join(fixtures, fixture);
  const r = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, 'licences.mjs'),
      'check',
      '--root',
      root,
      '--inventory',
      path.join(root, 'inventory.json'),
    ],
    { encoding: 'utf8' },
  );
  return { code: r.status, out: r.stdout + r.stderr };
}

test('licences: allow-listed, dual-licensed, reviewed and wildcard exceptions pass; notices match', () => {
  const r = gate('good');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /OK {3}licences/);
});

test('licences (negative): copyleft, AND with a copyleft part, changed licence, unreadable, stale notices', () => {
  const r = gate('bad');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /NOT_ALLOWED npm copyleft-pkg@1\.0\.0 "GPL-3\.0-only"/);
  assert.match(r.out, /NOT_ALLOWED npm half-copyleft@1\.0\.0/);
  // dev-tool has an exception for BlueOak-1.0.0 only: a new licence string is reviewed again.
  assert.match(r.out, /NOT_ALLOWED npm dev-tool@4\.0\.0 "BlueOak-2\.0\.0"/);
  assert.match(r.out, /UNREADABLE_LICENCE npm broken-expression/);
  // "BSD License" says neither 2- nor 3-clause: never guessed.
  assert.match(r.out, /UNREADABLE_LICENCE python httpx@0\.28\.1 "BSD License"/);
  assert.match(r.out, /NOTICES_OUT_OF_DATE/);
});

test('SPDX: OR needs one allowed branch, AND needs all, WITH is one id, parentheses group', () => {
  const allowed = new Set(['MIT', 'Apache-2.0']);
  const ok = (e) => isAllowed(parseSpdx(e), allowed);
  assert.equal(ok('MIT'), true);
  assert.equal(ok('(MIT OR CC0-1.0)'), true);
  assert.equal(ok('Apache-2.0 AND MIT'), true);
  assert.equal(ok('MIT AND GPL-3.0-only'), false);
  // AND binds tighter: GPL-3.0-only OR (MIT AND Apache-2.0) → allowed through the second branch.
  assert.equal(ok('GPL-3.0-only OR MIT AND Apache-2.0'), true);
  assert.equal(ok('(GPL-3.0-only OR MIT) AND LGPL-2.1-only'), false);
  assert.equal(ok('Apache-2.0 WITH LLVM-exception'), false);
  assert.equal(
    isAllowed(
      parseSpdx('Apache-2.0 WITH LLVM-exception'),
      new Set(['Apache-2.0 WITH LLVM-exception']),
    ),
    true,
  );
  for (const bad of ['', 'MIT OR', '(MIT', 'MIT)', 'AND MIT', 'MIT WITH']) {
    assert.throws(() => parseSpdx(bad), undefined, bad);
  }
});

test('Python classifiers: only unambiguous ones map; several classifiers read as OR', () => {
  assert.equal(pythonExpression('MIT License'), 'MIT');
  assert.equal(pythonExpression('Apache Software License; MIT License'), 'Apache-2.0 OR MIT');
  assert.equal(pythonExpression('BSD License'), 'BSD License');
  assert.equal(pythonExpression('MIT License; BSD License'), undefined);
  assert.equal(pythonExpression('MIT AND PSF-2.0'), 'MIT AND PSF-2.0');
  assert.equal(pyName('Typing_Extensions'), pyName('typing-extensions'));
});

test('notices list only the versions that ship; the gate still checks every version', () => {
  const inventory = {
    npm: {
      all: { MIT: [{ name: 'lru', versions: ['11.0.0', '7.0.0'] }] },
      prod: { MIT: [{ name: 'lru', versions: ['7.0.0'] }] },
    },
    python: { all: [], runtime: [] },
  };
  const rows = normalize(inventory);
  assert.deepEqual(rows[0].versions, ['11.0.0', '7.0.0']);
  assert.match(renderGenerated(rows), /\| lru \| 7\.0\.0 \| MIT \|/);
});

test('a licence field holding a whole licence text is cut in the error line', () => {
  const rows = normalize({
    npm: {
      all: { ['Permission is hereby granted '.repeat(20)]: [{ name: 'p', versions: ['1'] }] },
      prod: {},
    },
    python: { all: [], runtime: [] },
  });
  const [error] = checkLicences(rows, { allowed: ['MIT'], exceptions: [] });
  assert.match(error, /^UNREADABLE_LICENCE npm p@1 "Permission is hereby granted .{40,}\.\.\."$/);
  assert.ok(error.length < 120, error);
});
