import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const ALLOWED = /^(?:[A-Za-z0-9._%+-]+@users\.noreply\.github\.com|noreply@github\.com|[A-Za-z0-9._%+-]+@example\.(?:com|org|net))$/i;
const NOREPLY = /^(?:[A-Za-z0-9._%+-]+@users\.noreply\.github\.com|noreply@github\.com)$/i;
const ZERO = /^0+$/;

export const isNoreplyEmail = (email) => NOREPLY.test(email);

// True when the text contains an email address that is not an allowed noreply/example one.
export const hasPersonalEmail = (text) =>
  (String(text).match(EMAIL) ?? []).some((email) => !ALLOWED.test(email));

// Never include email values in findings; only locations.
export function auditCommit({ sha, authorEmail, committerEmail, message }) {
  const short = sha.slice(0, 12);
  const findings = [];
  if (!isNoreplyEmail(authorEmail)) findings.push(`${short}: author email is not a GitHub noreply address`);
  if (!isNoreplyEmail(committerEmail)) findings.push(`${short}: committer email is not a GitHub noreply address`);
  if (hasPersonalEmail(message)) findings.push(`${short}: commit message or trailer contains a personal email`);
  return findings;
}

const git = (args, cwd, env = process.env) => execFileSync('git', args, {
  cwd, env, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'],
});

export function listCommits(revs, cwd) {
  const out = git(['log', '-z', '--format=%H%x1f%ae%x1f%ce%x1f%B', ...revs], cwd);
  return out.split('\0').filter(Boolean).map((record) => {
    const [sha, authorEmail, committerEmail, ...rest] = record.replace(/^\n/, '').split('\x1f');
    return { sha, authorEmail, committerEmail, message: rest.join('\x1f') };
  });
}

// revs is an array of git rev arguments, e.g. ['base..head'] or ['head', '--not', 'base'].
export function auditRange(revs, cwd) {
  const findings = listCommits(revs, cwd).flatMap(auditCommit);
  const patch = git(['log', '-p', '--format=commit %H', '--unified=0', '--no-color', '--no-ext-diff', ...revs], cwd);
  let sha = '';
  let file = '';
  for (const line of patch.split('\n')) {
    if (line.startsWith('commit ')) sha = line.slice(7, 19);
    else if (line.startsWith('+++ ')) file = line.slice(4);
    else if (line.startsWith('+') && hasPersonalEmail(line.slice(1))) {
      findings.push(`${sha}: added content in ${file} contains a personal email`);
    }
  }
  return findings;
}

// Effective identities, including GIT_AUTHOR_* / GIT_COMMITTER_* environment overrides.
export function auditIdentity(cwd, env = process.env) {
  const findings = [];
  for (const kind of ['AUTHOR', 'COMMITTER']) {
    let ident = '';
    try {
      ident = git(['var', `GIT_${kind}_IDENT`], cwd, env);
    } catch {
      findings.push(`${kind.toLowerCase()} identity is not configured`);
      continue;
    }
    const email = ident.match(/<([^>]*)>/)?.[1] ?? '';
    if (!isNoreplyEmail(email)) findings.push(`effective ${kind.toLowerCase()} email is not a GitHub noreply address`);
  }
  return findings;
}

// pre-push stdin lines: <local ref> <local sha> <remote ref> <remote sha>
export function auditPushLines(text, cwd) {
  const findings = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const [, local, , remote] = line.split(' ');
    if (!local || ZERO.test(local)) continue;
    findings.push(...auditRange(remote && !ZERO.test(remote)
      ? [`${remote}..${local}`] : [local, '--not', '--remotes=origin'], cwd));
  }
  return findings;
}

function main(argv) {
  const [mode, ...rest] = argv;
  let findings;
  if (mode === 'identity') findings = auditIdentity(process.cwd());
  else if (mode === 'range' && rest[0]) {
    const [base, head] = rest;
    findings = auditRange(base && !ZERO.test(base) ? [`${base}..${head}`] : ['--max-count=1', head], process.cwd());
  } else if (mode === 'push') {
    findings = auditPushLines(readFileSync(0, 'utf8'), process.cwd());
  } else {
    console.error('Usage: commit-privacy.mjs identity | range <base|0000> <head> | push < pre-push-stdin');
    return 2;
  }
  if (findings.length) {
    console.error(`Commit privacy check failed:\n${findings.map((f) => `- ${f}`).join('\n')}`);
    return 1;
  }
  console.log('Commit privacy check passed.');
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch {
    console.error('Commit privacy check failed closed: could not inspect commits.');
    process.exitCode = 1;
  }
}
