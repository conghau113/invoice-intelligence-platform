// Each gate runs for real: a good tree exits 0, a bad tree exits 1 and names the problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkParity, icuArgs } from './check-i18n.mjs';
import { checkIndex } from './check-adr-index.mjs';
import { checkLinks, headingSlugs, stripCode } from './check-links.mjs';

const here = import.meta.dirname;
function gate(script, group, fixture) {
  const root = path.join(here, '__fixtures__', group, fixture);
  const r = spawnSync(process.execPath, [path.join(here, script), '--root', root], {
    encoding: 'utf8',
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('check-i18n: good tree passes, missing-intl-files tree is skipped until next-intl is used', () => {
  assert.equal(gate('check-i18n.mjs', 'i18n', 'ok').code, 0);
  const skipped = gate('check-i18n.mjs', 'i18n', 'skip');
  assert.equal(skipped.code, 0);
  assert.match(skipped.out, /SKIP/);
  assert.doesNotMatch(skipped.out, /OK/);
});

test('check-i18n (negative): missing key, different argument, and missing files in strict mode exit 1', () => {
  const key = gate('check-i18n.mjs', 'i18n', 'bad-key');
  assert.equal(key.code, 1);
  assert.match(key.out, /home\.extra/);
  const param = gate('check-i18n.mjs', 'i18n', 'bad-param');
  assert.equal(param.code, 1);
  assert.match(param.out, /different arguments/);
  assert.equal(gate('check-i18n.mjs', 'i18n', 'bad-missing').code, 1);
  assert.equal(gate('check-i18n.mjs', 'i18n', 'bad-onefile').code, 1);
  const json = gate('check-i18n.mjs', 'i18n', 'bad-json');
  assert.equal(json.code, 1);
  assert.match(json.out, /en\.json is not valid JSON/);
});

test('icuArgs reads outer ICU arguments, including plural', () => {
  assert.deepEqual([...icuArgs('Hi {name}, {n, plural, one {# a} other {# b}}')].sort(), [
    'n',
    'name',
  ]);
  assert.deepEqual(checkParity({ a: 'x {n}' }, { a: 'y {n}' }), []);
});

test('check-adr-index: good passes; unlisted ADR and dangling row exit 1', () => {
  assert.equal(gate('check-adr-index.mjs', 'adr', 'ok').code, 0);
  const unlisted = gate('check-adr-index.mjs', 'adr', 'bad-unlisted');
  assert.equal(unlisted.code, 1);
  assert.match(unlisted.out, /0002-b\.md is not in the README/);
  const dangling = gate('check-adr-index.mjs', 'adr', 'bad-dangling');
  assert.equal(dangling.code, 1);
  assert.match(dangling.out, /0009-gone\.md/);
  assert.deepEqual(checkIndex(['0000-template.md', 'README.md'], ''), []);
});

test('check-links: good passes (anchor with Vietnamese heading, code fence ignored); gone file and bad anchor exit 1', () => {
  assert.equal(gate('check-links.mjs', 'links', 'ok').code, 0);
  const file = gate('check-links.mjs', 'links', 'bad-file');
  assert.equal(file.code, 1);
  assert.match(file.out, /docs\/missing\.md/);
  const anchor = gate('check-links.mjs', 'links', 'bad-anchor');
  assert.equal(anchor.code, 1);
  assert.match(anchor.out, /no-such-heading/);
});

test('link helpers: slugs match GitHub, duplicates get a suffix, links inside code are dropped', () => {
  assert.deepEqual(
    [...headingSlugs('## 5. Cổng tự động\n## A\n## A\n')],
    ['5-cổng-tự-động', 'a', 'a-1'],
  );
  assert.doesNotMatch(stripCode('x `[a](b.md)`\n```\n[c](d.md)\n```'), /\]\(/);
  const files = new Map([['a/x.md', '[up](../y.md) [out](../../z.md)']]);
  const errors = checkLinks(files, (p) => p === 'y.md');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /leaves the repository/);
});

test('review fixes: underscore slugs, badge links, long fences, dot-dot names, ADR row forms, --root without value', () => {
  assert.deepEqual([...headingSlugs('## snake_case_name')], ['snake_case_name']);
  const badge = new Map([['a.md', '[![alt](img.png)](gone.md)']]);
  assert.equal(checkLinks(badge, (p) => p === 'img.png').length, 1);
  const longFence = new Map([['a.md', '````md\n```\n[x](nope.md)\n```\n````\n']]);
  assert.deepEqual(
    checkLinks(longFence, () => false),
    [],
  );
  assert.deepEqual(
    checkLinks(new Map([['a.md', '[x](..hidden.md)']]), () => true),
    [],
  );
  const readme = '| [0019](./0019-a.md#s) | A |\nProse [0020](0020-b.md)\n';
  assert.deepEqual(checkIndex(['0019-a.md', '0020-b.md'], readme), [
    '0020-b.md is not in the README table',
  ]);
  const r = spawnSync(process.execPath, [path.join(here, 'check-links.mjs'), '--root'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2);
});
