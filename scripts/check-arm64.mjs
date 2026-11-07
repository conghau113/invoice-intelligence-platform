// Checks that every image in compose.yaml publishes a linux/arm64 manifest (Oracle ARM, M4).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

// Absolute, not looked up in PATH: a writable PATH entry could otherwise replace the program.
// Ubuntu, WSL2 and the Oracle VM all install it here.
const DOCKER = '/usr/bin/docker';
if (!existsSync(DOCKER)) {
  console.error(
    `FAIL docker is not at ${DOCKER}: install it there or change DOCKER in this script`,
  );
  process.exit(1);
}
const run = (args) => execFileSync(DOCKER, args, { encoding: 'utf8' });
const images = run(['compose', 'config', '--images']).split('\n').filter(Boolean);

let failed = false;
for (const image of images) {
  let manifest;
  try {
    manifest = JSON.parse(run(['manifest', 'inspect', image]));
  } catch (err) {
    console.error(`FAIL ${image}: cannot inspect manifest (${err.message.split('\n')[0]})`);
    failed = true;
    continue;
  }
  const hasArm64 = (manifest.manifests ?? []).some(
    (m) => m.platform?.os === 'linux' && m.platform?.architecture === 'arm64',
  );
  console.log(`${hasArm64 ? 'OK  ' : 'FAIL'} ${image} linux/arm64`);
  failed ||= !hasArm64;
}
process.exit(failed ? 1 : 0);
