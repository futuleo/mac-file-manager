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
  assert.ok(!hasPersonalEmail(`Co-authored-by: C <${noreply}> icons/a${at}2x.png pkg${at}1.2.3`));
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
