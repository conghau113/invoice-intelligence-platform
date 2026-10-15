#!/usr/bin/env node
// Scans the git history for committed secrets with gitleaks (run in Docker, so nothing to install).
// CI runs the same image/version; bump GITLEAKS_IMAGE in both places together.
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

const GITLEAKS_IMAGE = 'zricethezav/gitleaks:v8.30.0';

// Test hook: scan another directory (the negative test points this at a throwaway repo).
const target = resolve(process.argv[2] ?? process.cwd());

// `target` goes into a `docker -v host:container` argument, where ':' and ',' would add mount options.
function isScannableDir(path) {
  try {
    return statSync(path).isDirectory() && !/[:,]/.test(path);
  } catch {
    return false;
  }
}
if (!isScannableDir(target)) {
  console.error('check-secrets: target must be an existing directory without ":" or ",".');
  process.exit(2);
}

const result = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '-v',
    `${target}:/repo`,
    GITLEAKS_IMAGE,
    'git',
    '/repo',
    '--redact', // never print the secret itself, only where it is
    '--no-banner',
    '--exit-code',
    '1',
  ],
  { stdio: 'inherit' },
);

if (result.error) {
  console.error(
    `check-secrets: cannot run docker (${result.error.message}). Start Docker Desktop.`,
  );
  process.exit(2);
}
process.exit(result.status ?? 2);
