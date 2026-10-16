// Gate: every ADR file is listed in docs/architecture/adr/README.md, and every listed file exists.
import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseRoot, report } from './lib/repo-check.mjs';

const ADR_FILE = /^\d{4}-.+\.md$/;
const TEMPLATE = '0000-template.md';
// Only table rows count (lines starting with '|'); tolerates a ./ prefix and a #anchor.
const TABLE_LINK = /\]\((?:\.\/)?(\d{4}-[^)\s#]+\.md)(?:#[^)\s]*)?\)/g;

export function checkIndex(files, readme) {
  const errors = [];
  const adrs = files.filter((f) => ADR_FILE.test(f) && f !== TEMPLATE);
  const rows = readme.split('\n').filter((l) => l.trimStart().startsWith('|'));
  const listed = new Set(rows.flatMap((l) => [...l.matchAll(TABLE_LINK)].map((m) => m[1])));
  for (const f of adrs) if (!listed.has(f)) errors.push(`${f} is not in the README table`);
  for (const f of listed)
    if (!files.includes(f)) errors.push(`README lists ${f} but the file does not exist`);
  return errors;
}

export function run(root) {
  const dir = path.join(root, 'docs', 'architecture', 'adr');
  const readmeFile = path.join(dir, 'README.md');
  if (!fs.existsSync(readmeFile)) return ['docs/architecture/adr/README.md is missing'];
  return checkIndex(fs.readdirSync(dir), fs.readFileSync(readmeFile, 'utf8'));
}

if (isMain(import.meta.url)) process.exit(report('check:adr', run(parseRoot(process.argv))));
