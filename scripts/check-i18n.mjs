// Gate: apps/web/messages/vi.json and en.json have the same keys and the same ICU arguments (ADR 0007).
import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseRoot, report } from './lib/repo-check.mjs';

// { a: { b: 'x' } } -> Map('a.b' -> 'x'). Only string leaves are messages.
export function flatten(obj, prefix = '', out = new Map()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out.set(key, v);
    else if (v !== null && typeof v === 'object') flatten(v, key, out);
  }
  return out;
}

// Names of the top-level ICU arguments: "{n, plural, one {# item} other {# items}}" -> ['n'].
// Known limits: arguments nested inside plural/select branches (depth > 1) are not compared, and ICU
// apostrophe quoting (`'{'`) is not understood.
export function icuArgs(message) {
  const names = new Set();
  let depth = 0;
  for (let i = 0; i < message.length; i++) {
    const c = message[i];
    if (c === '{') {
      if (depth === 0) {
        let j = i + 1;
        while (j < message.length && message[j] !== ',' && message[j] !== '}') j++;
        names.add(message.slice(i + 1, j).trim());
      }
      depth++;
    } else if (c === '}') depth = Math.max(0, depth - 1);
  }
  return names;
}

const fmt = (set) => [...set].sort().join(', ') || '(none)';

export function checkParity(vi, en) {
  const errors = [];
  const a = flatten(vi);
  const b = flatten(en);
  for (const key of a.keys())
    if (!b.has(key)) errors.push(`key "${key}" is in vi.json but not en.json`);
  for (const key of b.keys())
    if (!a.has(key)) errors.push(`key "${key}" is in en.json but not vi.json`);
  for (const [key, msg] of a) {
    if (!b.has(key)) continue;
    const x = icuArgs(msg);
    const y = icuArgs(b.get(key));
    if (fmt(x) !== fmt(y))
      errors.push(`key "${key}" has different arguments: vi {${fmt(x)}} vs en {${fmt(y)}}`);
  }
  return errors;
}

// Returns [value, error]: a broken file becomes a FAIL line, not a stack trace.
function readJson(file, root) {
  try {
    return [JSON.parse(fs.readFileSync(file, 'utf8')), null];
  } catch (err) {
    return [null, `${path.relative(root, file)} is not valid JSON (${err.message.split('\n')[0]})`];
  }
}

// Returns { errors, skipped }. skipped is a reason when nothing was checked.
export function run(root) {
  const web = path.join(root, 'apps', 'web');
  const vi = path.join(web, 'messages', 'vi.json');
  const en = path.join(web, 'messages', 'en.json');
  const present = [vi, en].filter((f) => fs.existsSync(f));

  if (present.length === 1)
    return { errors: ['only one of messages/vi.json and messages/en.json exists'] };
  if (present.length === 2) {
    const [a, ea] = readJson(vi, root);
    const [b, eb] = readJson(en, root);
    const errors = [ea, eb].filter(Boolean);
    return { errors: errors.length > 0 ? errors : checkParity(a, b) };
  }
  const pkgFile = path.join(web, 'package.json');
  let pkg = {};
  if (fs.existsSync(pkgFile)) {
    const [parsed, err] = readJson(pkgFile, root);
    if (err) return { errors: [err] };
    pkg = parsed;
  }
  const usesIntl = Boolean({ ...pkg.dependencies, ...pkg.devDependencies }['next-intl']);
  // Strict as soon as the app depends on next-intl; before that there is nothing to compare yet.
  if (usesIntl)
    return {
      errors: ['apps/web uses next-intl but messages/vi.json and messages/en.json are missing'],
    };
  return {
    errors: [],
    skipped: 'apps/web does not use next-intl yet (strict once it is a dependency)',
  };
}

if (isMain(import.meta.url)) {
  const { errors, skipped } = run(parseRoot(process.argv));
  process.exit(report('check:i18n', errors, skipped));
}
