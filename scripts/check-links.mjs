// Gate: relative links (and #anchors) in the repo's Markdown files point at something that exists.
// Not checked: http(s) and other schemes, reference-style links, HTML <a>. Links inside code are ignored.
import fs from 'node:fs';
import path from 'node:path';
import { isMain, parseRoot, report } from './lib/repo-check.mjs';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.venv',
  'dist',
  '.turbo',
  'coverage',
  '__fixtures__',
]);
// Matches every "](target)" so images inside links (badges) and the outer link are both checked.
const LINK = /\]\(([^)\s]+)(?:\s+"[^"\n]*")?\)/g;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

// Drops fenced blocks and inline code so example links in code are not checked.
export function stripCode(text) {
  let fence = null; // the opening marker, e.g. "```" or "~~~~"
  const kept = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence === null && m) fence = m[1];
    else if (fence !== null && m && m[1][0] === fence[0] && m[1].length >= fence.length)
      fence = null;
    else if (fence === null) {
      kept.push(line.replace(/`[^`\n]*`/g, ''));
      continue;
    }
    kept.push('');
  }
  return kept.join('\n');
}

// GitHub-style heading ids: lowercase, drop punctuation, spaces -> '-', repeated ids get -1, -2...
export function headingSlugs(text) {
  const seen = new Map();
  const slugs = new Set();
  for (const line of stripCode(text).split('\n')) {
    const m = /^#{1,6}\s+(.+)$/.exec(line);
    if (!m) continue;
    const plain = m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*~]/g, '');
    const base = plain
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
      .replace(/ /g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  }
  return slugs;
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

// files: Map(repo-relative posix path -> Markdown text); exists(path) tells if a file/dir exists.
export function checkLinks(files, exists) {
  const errors = [];
  const slugCache = new Map();
  const slugsOf = (p) => {
    if (!slugCache.has(p)) slugCache.set(p, headingSlugs(files.get(p)));
    return slugCache.get(p);
  };
  for (const [file, text] of files) {
    for (const m of stripCode(text).matchAll(LINK)) {
      const target = m[1];
      if (SCHEME.test(target)) continue;
      const hash = target.indexOf('#');
      const rawPath = hash === -1 ? target : target.slice(0, hash);
      const anchor = hash === -1 ? '' : safeDecode(target.slice(hash + 1)).toLowerCase();
      let resolved = file;
      if (rawPath !== '') {
        const p = safeDecode(rawPath);
        resolved = p.startsWith('/')
          ? path.posix.normalize(p.slice(1))
          : path.posix.join(path.posix.dirname(file), p);
        if (resolved === '..' || resolved.startsWith('../')) {
          errors.push(`${file}: link "${target}" leaves the repository`);
          continue;
        }
        if (!exists(resolved)) {
          errors.push(`${file}: link "${target}" -> ${resolved} does not exist`);
          continue;
        }
      }
      if (anchor !== '' && files.has(resolved) && !slugsOf(resolved).has(anchor)) {
        errors.push(`${file}: link "${target}" -> no heading "#${anchor}" in ${resolved}`);
      }
    }
  }
  return errors;
}

function collectMarkdown(root, rel = '', out = new Map()) {
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collectMarkdown(root, childRel, out);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      out.set(childRel, fs.readFileSync(path.join(root, childRel), 'utf8'));
    }
  }
  return out;
}

export function run(root) {
  return checkLinks(collectMarkdown(root), (p) => fs.existsSync(path.join(root, p)));
}

if (isMain(import.meta.url)) process.exit(report('check:links', run(parseRoot(process.argv))));
