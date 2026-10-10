import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MARKER = '# mac-file-manager commit-privacy hook';

const hook = (args, stdin) => `#!/bin/sh
${MARKER}
root=$(git rev-parse --show-toplevel) || exit 1
exec node "$root/scripts/commit-privacy.mjs" ${args}${stdin ? ' <&0' : ''}
`;

export const HOOKS = { 'pre-commit': hook('identity'), 'pre-push': hook('push', true) };

// Returns the names of hooks that already exist and are not ours; nothing is written then.
export function installHooks(dir) {
  const conflicts = Object.keys(HOOKS).filter((name) => {
    const path = join(dir, name);
    return existsSync(path) && !readFileSync(path, 'utf8').includes(MARKER);
  });
  if (conflicts.length) return conflicts;
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(HOOKS)) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  return [];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = resolve(execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim());
  const conflicts = installHooks(dir);
  if (conflicts.length) {
    console.error(`Existing hooks not overwritten: ${conflicts.join(', ')}. Add scripts/commit-privacy.mjs to them manually.`);
    process.exitCode = 1;
  } else {
    console.log(`Installed commit-privacy hooks in ${dir}`);
  }
}
