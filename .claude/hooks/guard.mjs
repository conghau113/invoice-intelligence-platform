#!/usr/bin/env node
// PreToolUse hook (cross-platform: Linux, WSL, macOS, Windows).
// Reads the tool call as JSON on stdin. Exit 2 = block the call; stderr is shown to Claude.
import { stdin } from 'node:process';

export const DANGEROUS = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f?\s+(\/|~|\$HOME)(\s|$)/,   // rm -rf / ~ $HOME
  /\bgit\s+push\b.*\s(--force|-f)(\s|$)/,                    // force push
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,            // pipe to shell
  /\bgit\s+reset\s+--hard\b/,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
];
const ENV_IN_CMD = /(^|[^\w.-])\.env(\.[\w-]+)?([^\w.-]|$)/;

export function isSecretPath(p = '') {
  const f = p.replace(/\\/g, '/');
  if (/\.env\.example$/.test(f)) return false;
  return /(^|\/)\.env(\.[\w-]+)?$/.test(f) || /\/secrets\//.test(f) || /\.(pem|key)$/.test(f);
}

export function decide(input) {
  const tool = input?.tool_name ?? '';
  const cmd = input?.tool_input?.command ?? '';
  const path = input?.tool_input?.file_path ?? '';
  if (tool === 'Bash' || tool === 'PowerShell') {
    if (DANGEROUS.some((r) => r.test(cmd))) {
      return { block: true, reason: `Blocked: dangerous command (${cmd}). Explain to Hậu and propose a safer alternative.` };
    }
    const withoutExample = cmd.replace(/\.env\.example/g, '');
    if (ENV_IN_CMD.test(withoutExample)) {
      return { block: true, reason: 'Blocked: commands touching .env files are not allowed. Use .env.example to describe variables.' };
    }
  }
  if (['Read', 'Edit', 'Write'].includes(tool) && isSecretPath(path)) {
    return { block: true, reason: `Blocked: secret file (${path}) must not be read or modified by the agent.` };
  }
  return { block: false };
}

async function main() {
  let raw = '';
  for await (const chunk of stdin) raw += chunk;
  let input;
  try { input = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const r = decide(input);
  if (r.block) { process.stderr.write(r.reason + '\n'); process.exit(2); }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('guard.mjs')) main();
