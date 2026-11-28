// Gate + generator for third-party licences (T7.4, docs/LEGAL.md §3).
//
//   pnpm check:licences   every npm and Python dependency (dev included) has an allow-listed licence
//                         or a reviewed exception, and THIRD_PARTY_NOTICES.md matches the lockfiles
//   pnpm gen:notices      rewrite the generated part of THIRD_PARTY_NOTICES.md
//
// The inventory comes from `pnpm licenses list` (reads the installed lockfile) and from pip-licenses
// in the AI service's uv environment. Tests pass `--inventory <file>` instead, so nothing is spawned.
// Output is package names, versions and licence ids only.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pnpmCommand } from './dev-api.mjs';
import { isMain, parseRoot, report } from './lib/repo-check.mjs';

const NAME = 'licences';
const POLICY = path.join('docs', 'legal', 'licence-policy.json');
const NOTICES = 'THIRD_PARTY_NOTICES.md';
export const GENERATED_MARKER =
  '<!-- Generated below by `pnpm gen:notices` from the lockfiles. Do not edit by hand. -->';

// --- SPDX expressions -------------------------------------------------------------------------
// Grammar (SPDX 2.3 annex D, enough for package metadata): or := and ("OR" and)*,
// and := atom ("AND" atom)*, atom := "(" or ")" | id ["WITH" id]. AND binds tighter than OR.
export function parseSpdx(text) {
  // filter: "".split() gives [""], which would otherwise read as a licence called "".
  const tokens = text
    .replaceAll('(', ' ( ')
    .replaceAll(')', ' ) ')
    .split(/\s+/)
    .filter((t) => t !== '');
  let i = 0;
  const peek = () => tokens[i];
  const take = () => tokens[i++];
  function atom() {
    const t = take();
    if (t === '(') {
      const inner = or();
      if (take() !== ')') throw new Error('unbalanced');
      return inner;
    }
    if (t === undefined || t === ')' || t === 'AND' || t === 'OR' || t === 'WITH') {
      throw new Error('expected a licence id');
    }
    if (peek() === 'WITH') {
      take();
      const exception = take();
      if (exception === undefined || exception === '(' || exception === ')') {
        throw new Error('expected an exception id');
      }
      return { id: `${t} WITH ${exception}` };
    }
    return { id: t };
  }
  function and() {
    const parts = [atom()];
    while (peek() === 'AND') {
      take();
      parts.push(atom());
    }
    return parts.length === 1 ? parts[0] : { and: parts };
  }
  function or() {
    const parts = [and()];
    while (peek() === 'OR') {
      take();
      parts.push(and());
    }
    return parts.length === 1 ? parts[0] : { or: parts };
  }
  const tree = or();
  if (i !== tokens.length) throw new Error('trailing tokens');
  return tree;
}

// OR: we may pick any one branch. AND: every part applies, so every part must be allowed.
export function isAllowed(tree, allowed) {
  if (tree.id !== undefined) return allowed.has(tree.id);
  if (tree.or) return tree.or.some((t) => isAllowed(t, allowed));
  return tree.and.every((t) => isAllowed(t, allowed));
}

// Python metadata often has a trove classifier instead of an SPDX expression. Only unambiguous ones
// are mapped: "BSD License" says neither 2- nor 3-clause, so such a package needs an exception
// naming what its licence file says. pip-licenses joins several classifiers with "; " (a package
// offered under each of them), read here as OR.
const CLASSIFIERS = new Map([
  ['MIT License', 'MIT'],
  ['Apache Software License', 'Apache-2.0'],
  ['Mozilla Public License 2.0 (MPL 2.0)', 'MPL-2.0'],
  ['3-Clause BSD License', 'BSD-3-Clause'],
  ['ISC License (ISCL)', 'ISC'],
  ['Python Software Foundation License', 'PSF-2.0'],
]);

export function pythonExpression(raw) {
  const parts = raw.split('; ');
  if (parts.length > 1 || CLASSIFIERS.has(raw)) {
    const ids = parts.map((p) => CLASSIFIERS.get(p));
    return ids.every(Boolean) ? ids.join(' OR ') : undefined;
  }
  return raw;
}

// PEP 503: "typing_extensions" (pip-licenses) and "typing-extensions" (uv export) are one package.
export const pyName = (name) => name.toLowerCase().replaceAll(/[-_.]+/g, '-');

// --- Inventory -------------------------------------------------------------------------------
// pnpm: { "<licence>": [{ name, versions, homepage }] } → flat rows.
function npmRows(byLicence) {
  return Object.entries(byLicence).flatMap(([licence, pkgs]) =>
    pkgs.map((p) => ({ name: p.name, versions: [...p.versions].sort(), licence, url: p.homepage })),
  );
}

export function normalize(inventory) {
  const runtime = new Set(inventory.python.runtime.map(pyName));
  // Keyed by licence and name: a package can be shipped at one version and used by dev tools at
  // another (even under another licence). The gate checks every version; the notices list only
  // the shipped ones.
  const key = (r) => `${r.licence}\u0000${r.name}`;
  const prod = new Map(npmRows(inventory.npm.prod).map((r) => [key(r), r.versions]));
  const npm = npmRows(inventory.npm.all).map((r) => ({
    ...r,
    ecosystem: 'npm',
    shipped: prod.has(key(r)),
    shippedVersions: prod.get(key(r)),
  }));
  const python = inventory.python.all.map((p) => ({
    ecosystem: 'python',
    name: p.Name,
    versions: [p.Version],
    licence: p.License,
    url: p.URL === 'UNKNOWN' ? undefined : p.URL,
    shipped: runtime.has(pyName(p.Name)),
  }));
  return [...npm, ...python];
}

// --- Gate -------------------------------------------------------------------------------------
// An exception names one package (a trailing "*" covers platform builds such as
// @img/sharp-libvips-linux-x64 / -linux-arm64) AND the exact licence string it was reviewed with:
// if a new release changes its licence, the exception stops applying and the package is flagged.
function findException(row, exceptions) {
  return exceptions.find(
    (e) =>
      e.ecosystem === row.ecosystem &&
      e.licence === row.licence &&
      (e.name.endsWith('*')
        ? row.name.startsWith(e.name.slice(0, -1))
        : row.ecosystem === 'python'
          ? pyName(e.name) === pyName(row.name)
          : e.name === row.name),
  );
}

export function checkLicences(rows, policy) {
  const allowed = new Set(policy.allowed);
  const errors = [];
  for (const row of rows) {
    if (findException(row, policy.exceptions)) continue;
    const label = `${row.ecosystem} ${row.name}@${row.versions.join('/')}`;
    // Some packages put the whole licence text in this field: keep the line readable.
    const shown = row.licence.length > 80 ? `${row.licence.slice(0, 77)}...` : row.licence;
    const expression = row.ecosystem === 'python' ? pythonExpression(row.licence) : row.licence;
    let tree;
    try {
      tree = expression === undefined ? undefined : parseSpdx(expression);
    } catch {
      tree = undefined;
    }
    if (tree === undefined) errors.push(`UNREADABLE_LICENCE ${label} "${shown}"`);
    else if (!isAllowed(tree, allowed)) errors.push(`NOT_ALLOWED ${label} "${shown}"`);
  }
  return errors;
}

// --- Notices ----------------------------------------------------------------------------------
const cell = (s) => (s ?? '').replaceAll('|', '\\|').replaceAll(/\s+/g, ' ').trim();

function table(rows) {
  const sorted = [...rows].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return [
    '| Package | Version | Licence | Source |',
    '|---|---|---|---|',
    ...sorted.map(
      (r) =>
        `| ${cell(r.name)} | ${cell((r.shippedVersions ?? r.versions).join(', '))} | ${cell(r.licence)} | ${cell(r.url)} |`,
    ),
  ].join('\n');
}

// Only what ships in an image (npm production dependencies of the workspace, the AI service's
// runtime group). Dev tools are checked by the gate but are not distributed.
export function renderGenerated(rows) {
  const npm = rows.filter((r) => r.ecosystem === 'npm' && r.shipped);
  const python = rows.filter((r) => r.ecosystem === 'python' && r.shipped);
  return [
    GENERATED_MARKER,
    '',
    `## npm packages shipped in the web and API images (${npm.length})`,
    '',
    'Production dependencies of the pnpm workspace (`pnpm -r --prod licenses list`), on linux-x64.',
    '',
    table(npm),
    '',
    `## Python packages shipped in the AI image (${python.length})`,
    '',
    'Runtime dependencies of `apps/ai` (`uv export --no-dev`), licences read by pip-licenses.',
    '',
    table(python),
    '',
  ].join('\n');
}

export function renderNotices(current, rows) {
  const at = current.indexOf(GENERATED_MARKER);
  const manual = (at === -1 ? current : current.slice(0, at)).trimEnd();
  return `${manual}\n\n${renderGenerated(rows)}`;
}

// --- Collecting (real repo only) --------------------------------------------------------------
function pnpm(root, args) {
  const execPath = process.env.npm_execpath;
  if (!execPath) throw new Error('Run it as: pnpm check:licences (or pnpm gen:notices)');
  // The pnpm that launched this script (a .cjs file or, since pnpm 12, a native binary): no PATH lookup.
  const { command, args: prefix } = pnpmCommand(execPath);
  const r = spawnSync(command, [...prefix, '--silent', ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed:\n${r.stderr}`);
  return r.stdout;
}

// A tool that printed a warning or nothing instead of JSON: say which one, not a bare stack trace.
function parseJson(what, text) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${what} did not print JSON`);
  }
}

function collect(root) {
  return {
    npm: {
      all: parseJson('pnpm -r licenses list', pnpm(root, ['-r', 'licenses', 'list', '--json'])),
      prod: parseJson(
        'pnpm -r --prod licenses list',
        pnpm(root, ['-r', '--prod', 'licenses', 'list', '--json']),
      ),
    },
    python: {
      all: parseJson(
        'pip-licenses (pnpm --filter ai licences:json)',
        pnpm(root, ['--filter', 'ai', 'licences:json']),
      ),
      runtime: pnpm(root, ['--filter', 'ai', 'deps:runtime'])
        .split('\n')
        .filter((l) => /^[A-Za-z0-9]/.test(l))
        .map((l) => l.split('==')[0]),
    },
  };
}

export function run(argv) {
  const mode = argv[0];
  if (mode !== 'check' && mode !== 'write') {
    console.error('usage: licences.mjs check|write [--root <dir>] [--inventory <file>]');
    return 2;
  }
  const root = parseRoot(argv);
  const inv = argv.indexOf('--inventory');
  const inventory =
    inv === -1 ? collect(root) : JSON.parse(fs.readFileSync(path.resolve(argv[inv + 1]), 'utf8'));
  const policy = JSON.parse(fs.readFileSync(path.join(root, POLICY), 'utf8'));
  const rows = normalize(inventory);
  const noticesPath = path.join(root, NOTICES);
  const current = fs.readFileSync(noticesPath, 'utf8');
  const expected = renderNotices(current, rows);
  if (mode === 'write') {
    fs.writeFileSync(noticesPath, expected);
    console.log(`wrote ${NOTICES}`);
    return report(NAME, checkLicences(rows, policy));
  }
  const errors = checkLicences(rows, policy);
  if (current !== expected) errors.push(`NOTICES_OUT_OF_DATE ${NOTICES} (run pnpm gen:notices)`);
  return report(NAME, errors);
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
