import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { auditCommit, auditIdentity, auditPushLines, auditRange, hasPersonalEmail, isNoreplyEmail } from './commit-privacy.mjs';
import { HOOKS, installHooks } from './install-git-hooks.mjs';

const at = '@';
const personal = `person${at}private.test`;
const noreply = `1+user${at}users.noreply.github.com`;
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
for (const key of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) delete baseEnv[key];

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-'));
  const run = (args, env = {}) => execFileSync('git', args, {
    cwd: dir, env: { ...baseEnv, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  run(['init', '-q', '-b', 'main']);
  run(['config', 'user.name', 'u']);
  run(['config', 'user.email', noreply]);
  const commit = (file, content, message = 'change', env = {}) => {
    writeFileSync(join(dir, file), content);
    run(['add', file]);
    run(['commit', '-q', '-m', message], env);
    return run(['rev-parse', 'HEAD']).trim();
  };
  return { dir, run, commit, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test('classifies emails without accepting lookalikes', () => {
  assert.ok(isNoreplyEmail(noreply));
  assert.ok(isNoreplyEmail(`noreply${at}github.com`));
  assert.ok(!isNoreplyEmail(personal));
  assert.ok(!isNoreplyEmail(`x${at}users.noreply.github.com.evil.test`));
  assert.ok(hasPersonalEmail(`see ${personal}`));
  assert.ok(!hasPersonalEmail(`Co-authored-by: C <${noreply}> pkg${at}1.2.3`));
  assert.ok(!hasPersonalEmail(`icons/a${at}2x.png`, { assets: true }));
});

test('audits author, committer and message fields without echoing values', () => {
  const ok = { sha: 'a'.repeat(40), authorEmail: noreply, committerEmail: noreply, message: 'm' };
  assert.deepEqual(auditCommit(ok), []);
  const findings = [
    ...auditCommit({ ...ok, authorEmail: personal }),
    ...auditCommit({ ...ok, committerEmail: personal }),
    ...auditCommit({ ...ok, message: `Co-authored-by: P <${personal}>` }),
  ];
  assert.equal(findings.length, 3);
  assert.ok(findings.every((finding) => !finding.includes(personal)));
});

test('audits every commit in a range, not only the tip', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    r.commit('b.txt', 'b', 'bad author', { GIT_AUTHOR_EMAIL: personal });
    const head = r.commit('c.txt', 'c');
    const findings = auditRange([`${base}..${head}`], r.dir);
    assert.equal(findings.length, 1);
    assert.ok(!findings.join().includes(personal));
    assert.deepEqual(auditRange([`${base}..${base}`], r.dir), []);
  } finally { r.done(); }
});

test('flags personal emails in messages, intermediate content and committer', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    r.commit('b.txt', `contact ${personal}`, `msg ${personal}`, { GIT_COMMITTER_EMAIL: personal });
    const head = r.commit('b.txt', 'clean');
    const findings = auditRange([`${base}..${head}`], r.dir);
    assert.equal(findings.length, 3);
    assert.ok(!findings.join().includes(personal));
  } finally { r.done(); }
});

test('effective identity honours environment overrides', () => {
  const r = repo();
  try {
    assert.deepEqual(auditIdentity(r.dir, baseEnv), []);
    assert.equal(auditIdentity(r.dir, { ...baseEnv, GIT_AUTHOR_EMAIL: personal }).length, 1);
    assert.equal(auditIdentity(r.dir, { ...baseEnv, GIT_COMMITTER_EMAIL: personal }).length, 1);
  } finally { r.done(); }
});

test('push audit covers whole outgoing ranges and new branches', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    r.commit('b.txt', 'b', 'x', { GIT_AUTHOR_EMAIL: personal });
    const head = r.commit('c.txt', 'c');
    const zero = '0'.repeat(40);
    assert.equal(auditPushLines(`refs/heads/f ${head} refs/heads/f ${base}\n`, r.dir).length, 1);
    assert.equal(auditPushLines(`refs/heads/f ${head} refs/heads/f ${zero}\n`, r.dir).length, 1);
    assert.deepEqual(auditPushLines(`(delete) ${zero} refs/heads/f ${base}\n`, r.dir), []);
  } finally { r.done(); }
});

test('hook installer refuses to overwrite foreign hooks and is idempotent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-'));
  try {
    assert.deepEqual(installHooks(dir), []);
    assert.deepEqual(installHooks(dir), []);
    writeFileSync(join(dir, 'pre-push'), '#!/bin/sh\necho mine\n');
    chmodSync(join(dir, 'pre-push'), 0o755);
    assert.deepEqual(installHooks(dir), ['pre-push']);
    assert.match(HOOKS['pre-commit'], /commit-privacy\.mjs" identity/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

const cli = (args, cwd) => {
  try {
    return { code: 0, out: execFileSync('node', [new URL('./commit-privacy.mjs', import.meta.url).pathname, ...args],
      { cwd, env: baseEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { code: error.status, out: `${error.stdout}${error.stderr}` };
  }
};
const zero = '0'.repeat(40);

test('new destination ref audits all ancestry even with stale tracking refs', () => {
  const r = repo();
  try {
    const first = r.commit('a.txt', 'a');
    r.run(['update-ref', 'refs/remotes/origin/main', first]);
    r.run(['update-ref', 'refs/remotes/other/main', first]);
    r.commit('b.txt', 'b', 'x', { GIT_AUTHOR_EMAIL: personal });
    const head = r.commit('c.txt', 'c');
    assert.equal(auditPushLines(`refs/heads/f ${head} refs/heads/f ${zero}\n`, r.dir).length, 1);
    const early = r.run(['rev-list', '--max-parents=0', 'HEAD']).trim();
    r.run(['update-ref', 'refs/remotes/origin/main', early]);
    assert.equal(auditPushLines(`refs/heads/f ${head} refs/heads/f ${zero}\n`, r.dir).length, 1);
  } finally { r.done(); }
});

test('zero-base range audits the whole history, not just the tip', () => {
  const r = repo();
  try {
    r.commit('a.txt', 'a');
    r.commit('b.txt', 'b', 'x', { GIT_AUTHOR_EMAIL: personal });
    const head = r.commit('c.txt', 'c');
    const result = cli(['range', zero, head], r.dir);
    assert.equal(result.code, 1);
    assert.ok(!result.out.includes(personal));
  } finally { r.done(); }
});

test('scans merge-only content', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    r.run(['checkout', '-q', '-b', 'side']);
    r.commit('s.txt', 's');
    r.run(['checkout', '-q', 'main']);
    r.commit('m.txt', 'm');
    r.run(['merge', '--no-commit', '--no-ff', 'side']);
    writeFileSync(join(r.dir, 'only-in-merge.txt'), `x ${personal}`);
    r.run(['add', 'only-in-merge.txt']);
    r.run(['commit', '-q', '-m', 'merge']);
    const findings = auditRange([`${base}..HEAD`], r.dir);
    assert.ok(findings.length >= 1);
    assert.ok(!findings.join().includes(personal));
  } finally { r.done(); }
});

test('audits added lines that look like patch headers', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    const head = r.commit('b.txt', `++ ${personal}\n`);
    assert.equal(auditRange([`${base}..${head}`], r.dir).length, 1);
    const head2 = r.commit('c.txt', `-- ${personal}\n+++ x\n@@ -1 +1 @@\n`);
    assert.equal(auditRange([`${head}..${head2}`], r.dir).length, 1);
  } finally { r.done(); }
});

test('flags email-bearing author and committer names locally and via identity', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    const env = { GIT_AUTHOR_NAME: personal, GIT_COMMITTER_NAME: personal };
    const head = r.commit('b.txt', 'b', 'x', env);
    const findings = auditRange([`${base}..${head}`], r.dir);
    assert.equal(findings.length, 2);
    assert.ok(!findings.join().includes(personal));
    assert.equal(auditIdentity(r.dir, { ...baseEnv, GIT_AUTHOR_NAME: personal }).length, 1);
    assert.equal(auditIdentity(r.dir, { ...baseEnv, GIT_COMMITTER_NAME: personal }).length, 1);
  } finally { r.done(); }
});

test('flags API-style commits with email-bearing names', () => {
  const ok = { sha: 'a'.repeat(40), authorEmail: noreply, committerEmail: noreply, message: 'm' };
  assert.equal(auditCommit({ ...ok, authorName: personal, committerName: 'u' }).length, 1);
  assert.equal(auditCommit({ ...ok, authorName: 'u', committerName: personal }).length, 1);
});

test('detects numeric-leading domains but not retina asset names', () => {
  for (const domain of ['123mail.test', '1-2.example.io', 'a.9z.test']) {
    assert.ok(hasPersonalEmail(`x ${'p'}${at}${domain}`), domain);
  }
  assert.ok(!hasPersonalEmail(`icons/logo${at}2x.png`, { assets: true }));
  assert.ok(hasPersonalEmail(`Co-authored-by: P <p${at}123mail.test>`));
});

test('CLI output never contains rejected values, including via filenames', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    const head = r.commit(`${personal}.txt`, `data ${personal}`, `msg ${personal}`, { GIT_AUTHOR_NAME: personal });
    const result = cli(['range', base, head], r.dir);
    assert.equal(result.code, 1);
    assert.ok(!result.out.includes(personal));
    assert.ok(!result.out.includes('private.test'));
  } finally { r.done(); }
});

test('content detection ignores diff config, attributes and context counts', () => {
  const r = repo();
  try {
    r.run(['config', 'diff.interHunkContext', '2']);
    r.run(['config', 'log.diffMerges', 'combined']);
    const lines = Array.from({ length: 12 }, (_, i) => `line ${i}`);
    writeFileSync(join(r.dir, 'f.txt'), `${lines.join('\n')}\n`);
    writeFileSync(join(r.dir, 'g.txt'), 'one\n');
    const base = r.commit('f.txt', `${lines.join('\n')}\n`);
    r.run(['add', 'g.txt']);
    r.run(['commit', '-q', '-m', 'g']);
    const edited = [...lines];
    edited[1] = 'changed'; edited[4] = 'changed';
    writeFileSync(join(r.dir, 'f.txt'), `${edited.join('\n')}\n`);
    writeFileSync(join(r.dir, 'g.txt'), `one\n${personal}\n`);
    r.run(['add', '-A']);
    r.run(['commit', '-q', '-m', 'edit']);
    assert.equal(auditRange([`${base}..HEAD`], r.dir).length, 1);

    writeFileSync(join(r.dir, '.gitattributes'), 'hidden.txt -diff\n');
    r.run(['add', '.gitattributes']);
    r.run(['commit', '-q', '-m', 'attr']);
    const before = r.run(['rev-parse', 'HEAD']).trim();
    const head = r.commit('hidden.txt', `x ${personal}\n`);
    assert.equal(auditRange([`${before}..${head}`], r.dir).length, 1);

    r.run(['checkout', '-q', '-b', 'side']);
    r.commit('s.txt', 's');
    r.run(['checkout', '-q', 'main']);
    r.commit('m.txt', 'm');
    const pre = r.run(['rev-parse', 'HEAD']).trim();
    r.run(['merge', '--no-commit', '--no-ff', 'side']);
    writeFileSync(join(r.dir, 'only.txt'), `x ${personal}\n`);
    r.run(['add', 'only.txt']);
    r.run(['commit', '-q', '-m', 'merge']);
    assert.ok(auditRange([`${pre}..HEAD`], r.dir).length >= 1);
  } finally { r.done(); }
});

test('retina exception applies to content only, not names, trailers or addresses', () => {
  const asset = `p${at}2x.png`;
  assert.ok(!hasPersonalEmail(`icons/${asset}`, { assets: true }));
  assert.ok(hasPersonalEmail(asset));
  assert.ok(hasPersonalEmail(`Co-authored-by: P <${asset}>`, { assets: true }));
  assert.ok(hasPersonalEmail(`Co-authored-by: ${asset}`, { assets: true }));
  assert.ok(hasPersonalEmail(`<${asset}>`, { assets: true }));
  const ok = { sha: 'a'.repeat(40), authorEmail: noreply, committerEmail: noreply, message: 'm' };
  assert.equal(auditCommit({ ...ok, authorName: asset }).length, 1);
  assert.equal(auditCommit({ ...ok, message: `Co-authored-by: P <${asset}>` }).length, 1);
  const r = repo();
  try {
    assert.equal(auditIdentity(r.dir, { ...baseEnv, GIT_AUTHOR_NAME: asset }).length, 1);
  } finally { r.done(); }
});

test('stale tracking ref at the sensitive tip does not hide a new-ref push', () => {
  const r = repo();
  try {
    r.commit('a.txt', 'a');
    const head = r.commit('b.txt', 'b', 'x', { GIT_AUTHOR_EMAIL: personal });
    r.run(['update-ref', 'refs/remotes/origin/main', head]);
    assert.equal(auditPushLines(`refs/heads/f ${head} refs/heads/f ${zero}\n`, r.dir).length, 1);
  } finally { r.done(); }
});

test('retina asset file paths are accepted, other email-like paths are not', () => {
  const r = repo();
  try {
    const base = r.commit('a.txt', 'a');
    mkdirSync(join(r.dir, 'icons'));
    const head = r.commit('icons/icon@2x.svg', '<svg/>\n');
    assert.deepEqual(auditRange([`${base}..${head}`], r.dir), []);
    assert.equal(cli(['range', base, head], r.dir).code, 0);
    const bad = r.commit(`${personal}.txt`, 'x');
    const result = cli(['range', head, bad], r.dir);
    assert.equal(result.code, 1);
    assert.ok(!result.out.includes(personal));
  } finally { r.done(); }
});
