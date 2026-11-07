// Gate: eval/datasets/v1 is what its manifest says, file by file, so scores stay comparable. There is
// no skip: a missing dataset fails. Output is ids and fixed codes, never document content.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { isMain, report } from './lib/repo-check.mjs';

const DATASET = path.resolve(import.meta.dirname, '..', 'eval', 'datasets', 'v1');
const ID = /^(?:invoice-[0-9]{4}|injection-[0-9]{2}|regression-[0-9]{2})$/;
// A name becomes a path: a manifest must not be able to point outside the folder.
const FILE = /^[a-z]+-[0-9]{2,4}\.(?:expected\.json|xml|pdf|png|jpg)$/;
// Files are checked against the manifest, so the manifest itself is pinned here: otherwise changing a
// file and its hash together, or picking another smoke set of the same mix, would pass. A new dataset
// version changes this line, where a reviewer sees it.
const MANIFEST_SHA256 = '09abbf3843d2cd8345c7f796840bf36d65d0170e5700ced3126d76a115ef2614';
const CORE_MIX = { easy: 40, medium: 40, hard: 20 };
const SMOKE_MIX = { easy: 8, medium: 8, hard: 4 };

export function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function checkDocument(entry, read, errors) {
  const { id, files = {}, primary } = entry;
  if (!ID.test(id ?? '')) return errors.push('BAD_DOCUMENT_ID');
  if (!Object.hasOwn(files, primary)) errors.push(`${id} PRIMARY_NOT_IN_FILES`);
  if (!Object.hasOwn(files, `${id}.expected.json`)) errors.push(`${id} NO_GROUND_TRUTH`);
  for (const [name, expected] of Object.entries(files)) {
    if (!FILE.test(name) || !name.startsWith(`${id}.`)) {
      errors.push(`${id} BAD_FILE_NAME`);
      continue;
    }
    const content = read(name);
    if (content === undefined) errors.push(`${id} FILE_MISSING ${name}`);
    else if (sha256(content) !== expected) errors.push(`${id} HASH_MISMATCH ${name}`);
  }
  return undefined;
}

function checkMix(name, ids, byId, mix, errors) {
  const expectedCount = Object.values(mix).reduce((a, b) => a + b, 0);
  if (ids.length !== expectedCount) errors.push(`${name} HAS_${ids.length}_DOCUMENTS`);
  for (const [difficulty, expected] of Object.entries(mix)) {
    const count = ids.filter((id) => byId.get(id)?.difficulty === difficulty).length;
    if (count !== expected) errors.push(`${name} HAS_${count}_${difficulty.toUpperCase()}`);
  }
}

function readPath(data, dotted) {
  let current = data;
  for (const key of dotted.split('.')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) {
      return { found: false };
    }
    current = current[key];
  }
  return { found: true, value: current };
}

// A goal equal to the ground truth would count a correct read as an attack that worked.
function checkAttack(id, entry, read, errors) {
  const goal = entry.attack?.goal;
  if (typeof goal?.path !== 'string' || !Object.hasOwn(goal, 'value')) {
    errors.push(`${id} ATTACK_WITHOUT_GOAL`);
    return;
  }
  const content = read(`${id}.expected.json`);
  if (content === undefined) return; // already reported as FILE_MISSING
  let truth;
  try {
    truth = JSON.parse(content.toString('utf8'));
  } catch {
    errors.push(`${id} GROUND_TRUTH_NOT_JSON`);
    return;
  }
  const target = readPath(truth, goal.path);
  if (!target.found) errors.push(`${id} ATTACK_GOAL_PATH_UNKNOWN`);
  else if (isDeepStrictEqual(target.value, goal.value))
    errors.push(`${id} ATTACK_GOAL_EQUALS_TRUTH`);
}

function checkSplits(splits, byId, read, errors) {
  const { core = [], smoke = [], injection = [], regression = [] } = splits ?? {};
  const owned = [...core, ...injection, ...regression];
  if (new Set(owned).size !== owned.length) errors.push('DOCUMENT_IN_TWO_SPLITS');
  for (const id of owned) if (!byId.has(id)) errors.push(`${id} IN_SPLIT_BUT_NOT_LISTED`);
  for (const id of byId.keys()) if (!owned.includes(id)) errors.push(`${id} IN_NO_SPLIT`);
  checkMix('core', core, byId, CORE_MIX, errors);
  checkMix('smoke', smoke, byId, SMOKE_MIX, errors);
  if (new Set(smoke).size !== smoke.length) errors.push('DUPLICATE_IN_SMOKE');
  for (const id of smoke) if (!core.includes(id)) errors.push(`${id} SMOKE_OUTSIDE_CORE`);
  // Attack scores must not leak into accuracy, and an attack without a goal cannot be scored.
  for (const id of core) if (byId.get(id)?.attack) errors.push(`${id} ATTACK_IN_CORE`);
  if (injection.length === 0) errors.push('NO_INJECTION_DOCUMENTS');
  for (const id of injection) if (byId.has(id)) checkAttack(id, byId.get(id), read, errors);
  if (regression.length === 0) errors.push('NO_REGRESSION_DOCUMENTS');
}

// `names` lists what is on disk; `read` answers a file's bytes or undefined when it is not there.
export function checkDataset(manifest, names, read) {
  const errors = [];
  const documents = manifest.documents ?? [];
  const byId = new Map(documents.map((entry) => [entry.id, entry]));
  if (byId.size !== documents.length) errors.push('DUPLICATE_DOCUMENT_ID');
  for (const entry of documents) checkDocument(entry, read, errors);
  checkSplits(manifest.splits, byId, read, errors);
  const listed = new Set(documents.flatMap((entry) => Object.keys(entry.files ?? {})));
  for (const name of names) if (!listed.has(name)) errors.push(`UNLISTED_FILE ${name}`);
  return errors;
}

export function run(root) {
  const manifestFile = path.join(root, 'manifest.json');
  if (!fs.existsSync(manifestFile)) return ['MANIFEST_MISSING'];
  const errors = fs.existsSync(path.join(root, 'README.md')) ? [] : ['README_MISSING'];
  const folder = path.join(root, 'documents');
  const names = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  const read = (name) =>
    names.includes(name) ? fs.readFileSync(path.join(folder, name)) : undefined;
  const raw = fs.readFileSync(manifestFile);
  if (sha256(raw) !== MANIFEST_SHA256) errors.push('MANIFEST_CHANGED');
  return [...errors, ...checkDataset(JSON.parse(raw.toString('utf8')), names, read)];
}

if (isMain(import.meta.url)) process.exit(report('check:eval-dataset', run(DATASET)));
