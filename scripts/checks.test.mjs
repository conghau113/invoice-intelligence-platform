// Each gate runs for real: a good tree exits 0, a bad tree exits 1 and names the problem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkParity, icuArgs } from './check-i18n.mjs';
import { checkIndex } from './check-adr-index.mjs';
import { checkLinks, headingSlugs, stripCode } from './check-links.mjs';
import { checkDataset, run as runEvalDataset, sha256 } from './check-eval-dataset.mjs';

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

// A small valid dataset in memory: the mix and the hashes are the real rules, the content is not.
function evalDataset() {
  const content = new Map();
  const documents = [];
  const add = (id, difficulty, extra = {}, body = id) => {
    const name = `${id}.expected.json`;
    content.set(name, Buffer.from(body));
    documents.push({ id, difficulty, primary: name, files: { [name]: sha256(body) }, ...extra });
  };
  const core = [];
  const smoke = [];
  for (let i = 0; i < 100; i += 1) {
    const id = `invoice-${String(i).padStart(4, '0')}`;
    const difficulty = i < 40 ? 'easy' : i < 80 ? 'medium' : 'hard';
    add(id, difficulty);
    core.push(id);
    if (i < 8 || (i >= 40 && i < 48) || (i >= 80 && i < 84)) smoke.push(id);
  }
  add(
    'injection-00',
    'injection',
    { attack: { goal: { path: 'seller.total', value: 0 } } },
    JSON.stringify({ seller: { total: 100 } }),
  );
  add('regression-00', 'regression');
  return {
    manifest: {
      documents,
      splits: { core, smoke, injection: ['injection-00'], regression: ['regression-00'] },
    },
    content,
  };
}

function checkEval({ manifest, content }) {
  return checkDataset(manifest, [...content.keys()], (name) => content.get(name));
}

test('check-eval-dataset: a dataset that matches its manifest passes', () => {
  assert.deepEqual(checkEval(evalDataset()), []);
});

test('check-eval-dataset: the real committed dataset passes, and the gate has no skip', () => {
  const r = spawnSync(process.execPath, [path.join(here, 'check-eval-dataset.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /OK {3}check:eval-dataset/);
});

test('check-eval-dataset (negative): a changed manifest fails even when it agrees with itself', () => {
  const root = path.join(here, '__fixtures__', 'eval-dataset', 'changed-manifest');
  assert.ok(runEvalDataset(root).includes('MANIFEST_CHANGED'));
});

test('check-eval-dataset (negative): an absent dataset fails instead of being skipped', () => {
  const root = path.join(here, '__fixtures__', 'eval-dataset', 'absent');
  assert.deepEqual(runEvalDataset(root), ['MANIFEST_MISSING']);
});

const injectionOf = (d) => d.manifest.documents[100];
const damages = [
  [
    'the same document twice in smoke',
    /DUPLICATE_IN_SMOKE/,
    (d) => {
      d.manifest.splits.smoke[1] = d.manifest.splits.smoke[0];
    },
  ],
  [
    'a goal with no value',
    /injection-00 ATTACK_WITHOUT_GOAL/,
    (d) => {
      delete injectionOf(d).attack.goal.value;
    },
  ],
  [
    'a goal equal to the ground truth',
    /injection-00 ATTACK_GOAL_EQUALS_TRUTH/,
    (d) => {
      injectionOf(d).attack.goal.value = 100;
    },
  ],
  [
    'a goal path the ground truth does not have',
    /injection-00 ATTACK_GOAL_PATH_UNKNOWN/,
    (d) => {
      injectionOf(d).attack.goal.path = 'seller.constructor';
    },
  ],
  [
    'a ground truth that is not JSON',
    /injection-00 GROUND_TRUTH_NOT_JSON/,
    (d) => {
      d.content.set('injection-00.expected.json', Buffer.from('not json'));
    },
  ],
  [
    'one changed byte',
    /invoice-0003 HASH_MISMATCH/,
    (d) => d.content.set('invoice-0003.expected.json', Buffer.from('x')),
  ],
  [
    'a missing file',
    /invoice-0003 FILE_MISSING/,
    (d) => d.content.delete('invoice-0003.expected.json'),
  ],
  [
    'a file the manifest does not list',
    /UNLISTED_FILE extra\.pdf/,
    (d) => d.content.set('extra.pdf', Buffer.from('x')),
  ],
  [
    'a name pointing outside the folder',
    /BAD_FILE_NAME/,
    (d) => {
      const entry = d.manifest.documents[0];
      entry.files = { ...entry.files, 'invoice-0000.pdf/../../../secret.pdf': 'x' };
    },
  ],
  [
    "a name of another document's file",
    /invoice-0000 BAD_FILE_NAME/,
    (d) => {
      const entry = d.manifest.documents[0];
      entry.files = { ...entry.files, 'invoice-0001.pdf': 'x' };
    },
  ],
  [
    'an unknown document id',
    /BAD_DOCUMENT_ID/,
    (d) => {
      d.manifest.documents[0].id = '../x';
    },
  ],
  [
    'no ground truth',
    /invoice-0000 NO_GROUND_TRUTH/,
    (d) => {
      const entry = d.manifest.documents[0];
      delete entry.files['invoice-0000.expected.json'];
    },
  ],
  [
    'a primary that is not a file',
    /invoice-0000 PRIMARY_NOT_IN_FILES/,
    (d) => {
      d.manifest.documents[0].primary = 'invoice-0000.pdf';
    },
  ],
  [
    'the wrong mix of difficulty',
    /core HAS_39_EASY/,
    (d) => {
      d.manifest.documents[0].difficulty = 'hard';
    },
  ],
  [
    'fewer than 100 documents',
    /core HAS_99_DOCUMENTS/,
    (d) => {
      d.manifest.splits.core.pop();
    },
  ],
  [
    'a smoke set of the wrong mix',
    /smoke HAS_7_EASY/,
    (d) => {
      d.manifest.splits.smoke[0] = 'invoice-0079';
    },
  ],
  [
    'a smoke document outside the 100',
    /injection-00 SMOKE_OUTSIDE_CORE/,
    (d) => {
      d.manifest.splits.smoke[19] = 'injection-00';
    },
  ],
  [
    'a document in two splits',
    /DOCUMENT_IN_TWO_SPLITS/,
    (d) => {
      d.manifest.splits.injection.push('invoice-0000');
    },
  ],
  [
    'a listed document in no split',
    /regression-00 IN_NO_SPLIT/,
    (d) => {
      d.manifest.splits.regression = [];
    },
  ],
  [
    'an attack counted in accuracy',
    /invoice-0000 ATTACK_IN_CORE/,
    (d) => {
      d.manifest.documents[0].attack = { goal: { path: 'total' } };
    },
  ],
  [
    'an attack that cannot be scored',
    /injection-00 ATTACK_WITHOUT_GOAL/,
    (d) => {
      delete d.manifest.documents[100].attack;
    },
  ],
  [
    'no attack documents',
    /NO_INJECTION_DOCUMENTS/,
    (d) => {
      d.manifest.splits.injection = [];
      d.manifest.documents.splice(100, 1);
      d.content.delete('injection-00.expected.json');
    },
  ],
];

for (const [name, expected, damage] of damages) {
  test(`check-eval-dataset (negative): ${name}`, () => {
    const dataset = evalDataset();
    damage(dataset);
    assert.match(checkEval(dataset).join('\n'), expected);
  });
}
