// Shared helpers for the check-*.mjs gates: argument parsing, reporting, "am I the entry point".
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// `--root <dir>` lets tests point a gate at a fixture tree instead of the real repo.
export function parseRoot(argv) {
  const i = argv.indexOf('--root');
  if (i === -1) return repoRoot;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) {
    console.error('FAIL: --root needs a directory');
    process.exit(2);
  }
  return path.resolve(value);
}

// Prints one line per error and returns the process exit code (1 = gate failed).
// `skipped` (a reason) means nothing was checked: print SKIP, never OK.
export function report(name, errors, skipped) {
  for (const e of errors) console.error(`FAIL ${name}: ${e}`);
  if (errors.length > 0) return 1;
  console.log(skipped ? `SKIP ${name}: ${skipped}` : `OK   ${name}`);
  return 0;
}

export function isMain(metaUrl) {
  return process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(metaUrl);
}
