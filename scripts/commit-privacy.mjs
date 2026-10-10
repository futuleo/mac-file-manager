import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Retina asset names such as icon@2x.png are not addresses; every other domain shape is.
const ASSET = /@\d+x\.(?:png|jpe?g|gif|webp|svg|ico|icns|avif)$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}/g;
const ALLOWED = /^(?:[A-Za-z0-9._%+-]+@users\.noreply\.github\.com|noreply@github\.com|[A-Za-z0-9._%+-]+@example\.(?:com|org|net))$/i;
const NOREPLY = /^(?:[A-Za-z0-9._%+-]+@users\.noreply\.github\.com|noreply@github\.com)$/i;
const ZERO = /^0+$/;

export const isNoreplyEmail = (email) => NOREPLY.test(email);

// True when the text contains an email address that is not an allowed noreply/example one.
export const hasPersonalEmail = (text) =>
  (String(text).match(EMAIL) ?? []).some((email) => !ALLOWED.test(email) && !ASSET.test(email));

// Never include email values in findings; only locations.
export function auditCommit({ sha, authorEmail, committerEmail, authorName = '', committerName = '', message }) {
  const short = sha.slice(0, 12);
  const findings = [];
  if (!isNoreplyEmail(authorEmail)) findings.push(`${short}: author email is not a GitHub noreply address`);
  if (!isNoreplyEmail(committerEmail)) findings.push(`${short}: committer email is not a GitHub noreply address`);
  if (hasPersonalEmail(authorName)) findings.push(`${short}: author name contains an email address`);
  if (hasPersonalEmail(committerName)) findings.push(`${short}: committer name contains an email address`);
  if (hasPersonalEmail(message)) findings.push(`${short}: commit message or trailer contains a personal email`);
  return findings;
}

const git = (args, cwd, env = process.env) => execFileSync('git', args, {
  cwd, env, encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'],
});

export function listCommits(revs, cwd) {
  const out = git(['log', '-z', '--format=%H%x1f%ae%x1f%ce%x1f%an%x1f%cn%x1f%B', ...revs], cwd);
  return out.split('\0').filter(Boolean).map((record) => {
    const [sha, authorEmail, committerEmail, authorName, committerName, ...rest] =
      record.replace(/^\n/, '').split('\x1f');
    return { sha, authorEmail, committerEmail, authorName, committerName, message: rest.join('\x1f') };
  });
}

// Scans a unified=0 patch using hunk line counts, so added lines that merely look like
// file headers are still audited. Paths are never reported; only a file ordinal is.
export function auditPatch(patch) {
  const findings = [];
  let sha = '';
  let fileNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of patch.split('\n')) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith('+')) {
        newLeft -= 1;
        if (hasPersonalEmail(line.slice(1))) findings.push(`${sha}: added content in changed file #${fileNo} contains a personal email`);
      } else if (line.startsWith('-')) oldLeft -= 1;
      continue;
    }
    if (line.startsWith('commit ')) { sha = line.slice(7, 19); fileNo = 0; }
    else if (line.startsWith('diff ')) {
      fileNo += 1;
      if (hasPersonalEmail(line)) findings.push(`${sha}: path of changed file #${fileNo} contains a personal email`);
    } else if (/^(?:rename|copy) (?:from|to) /.test(line) && hasPersonalEmail(line)) {
      findings.push(`${sha}: path of changed file #${fileNo} contains a personal email`);
    } else {
      const hunk = line.match(/^@@+ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        newLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      }
    }
  }
  return findings;
}

// revs is an array of git rev arguments, e.g. ['base..head'] or ['head'] for all ancestry.
// -m also diffs merge commits against each parent so merge-only content is scanned.
export function auditRange(revs, cwd) {
  const findings = listCommits(revs, cwd).flatMap(auditCommit);
  const patch = git(['log', '-p', '-m', '--format=commit %H', '--unified=0', '--no-color', '--no-ext-diff',
    '--no-renames', ...revs], cwd);
  return [...findings, ...auditPatch(patch)];
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
    const email = ident.match(/<([^<>]*)>[^<>]*$/)?.[1] ?? '';
    const name = ident.replace(/\s*<[^<>]*>[^<>]*$/, '');
    if (hasPersonalEmail(name)) findings.push(`effective ${kind.toLowerCase()} name contains an email address`);
    if (!isNoreplyEmail(email)) findings.push(`effective ${kind.toLowerCase()} email is not a GitHub noreply address`);
  }
  return findings;
}

// pre-push stdin lines: <local ref> <local sha> <remote ref> <remote sha>.
// A new destination ref is never assumed to share history with local tracking refs
// (they can be stale or belong to another remote), so all ancestry of the pushed sha is audited.
export function auditPushLines(text, cwd) {
  const findings = [];
  for (const line of text.split('\n').filter(Boolean)) {
    const [, local, , remote] = line.split(' ');
    if (!local || ZERO.test(local)) continue;
    findings.push(...auditRange(remote && !ZERO.test(remote) ? [`${remote}..${local}`] : [local], cwd));
  }
  return findings;
}

function main(argv) {
  const [mode, ...rest] = argv;
  let findings;
  if (mode === 'identity') findings = auditIdentity(process.cwd());
  else if (mode === 'range' && rest[0]) {
    const [base, head] = rest;
    findings = auditRange(base && !ZERO.test(base) ? [`${base}..${head}`] : [head], process.cwd());
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
