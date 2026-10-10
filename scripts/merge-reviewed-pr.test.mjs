import assert from 'node:assert/strict';
import test from 'node:test';
import { assertMergeable, COPILOT_TRAILER, REPOSITORY, REVIEW_CONTEXT, squashRequest } from './merge-reviewed-pr.mjs';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const personal = `person${'@'}private.test`;
const noreply = '1+user@users.noreply.github.com';
const fixture = () => ({
  commits: [{ sha: 'd'.repeat(40), authorEmail: noreply, committerEmail: 'noreply@github.com',
    message: `Change\n\n${COPILOT_TRAILER}` }],
  pr: {
    commits: 1,
    state: 'open', draft: false, mergeable: true, mergeable_state: 'clean',
    base: { ref: 'main', repo: { full_name: REPOSITORY } },
    head: { sha: head, repo: { full_name: REPOSITORY } },
  },
  mainSha: base,
  statuses: [{ context: REVIEW_CONTEXT, state: 'success', description: `Reviewed base ${base}` }],
  checks: [{ id: 1, name: 'validate', status: 'completed', conclusion: 'success',
    app: { slug: 'github-actions' } }],
  reviews: [],
  threads: { nodes: [], pageInfo: { hasNextPage: false } },
});

test('accepts only a clean, validated and independently reviewed revision', () => {
  assert.doesNotThrow(() => assertMergeable(fixture(), head, base));
});

const blockers = {
  'closed PR': (data) => { data.pr.state = 'closed'; },
  'draft PR': (data) => { data.pr.draft = true; },
  'wrong branch': (data) => { data.pr.base.ref = 'other'; },
  'foreign head repository': (data) => { data.pr.head.repo.full_name = 'other/repo'; },
  'deleted head repository': (data) => { data.pr.head.repo = null; },
  'changed head': (data) => { data.pr.head.sha = 'c'.repeat(40); },
  'changed main': (data) => { data.mainSha = 'c'.repeat(40); },
  'missing review': (data) => { data.statuses = []; },
  'pending review': (data) => { data.statuses[0].state = 'pending'; },
  'failed review': (data) => { data.statuses[0].state = 'failure'; },
  'stale base attestation': (data) => { data.statuses[0].description = 'Reviewed base old'; },
  'missing CI': (data) => { data.checks = []; },
  'pending CI': (data) => { data.checks[0].status = 'in_progress'; },
  'failed CI': (data) => { data.checks[0].conclusion = 'failure'; },
  'skipped CI': (data) => { data.checks[0].conclusion = 'skipped'; },
  'non-Actions check': (data) => { data.checks[0].app.slug = 'other'; },
  'new failed rerun': (data) => { data.checks.push({ ...data.checks[0], id: 2, conclusion: 'failure' }); },
  'changes requested': (data) => { data.reviews = [{ user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' }]; },
  'unresolved thread': (data) => { data.threads.nodes = [{ isResolved: false }]; },
  'uninspected threads': (data) => { data.threads.pageInfo.hasNextPage = true; },
  'personal author email': (data) => { data.commits[0].authorEmail = personal; },
  'personal committer email': (data) => { data.commits[0].committerEmail = personal; },
  'personal trailer email': (data) => { data.commits[0].message += `\nCo-authored-by: P <${personal}>`; },
  'uninspected commits': (data) => { data.commits = undefined; },
  'incomplete commit list': (data) => { data.pr.commits = 2; },
  'unknown mergeability': (data) => { data.pr.mergeable = null; },
  'dirty mergeability': (data) => { data.pr.mergeable_state = 'dirty'; },
};
for (const [name, mutate] of Object.entries(blockers)) {
  test(`blocks ${name}`, () => {
    const data = fixture();
    mutate(data);
    assert.throws(() => assertMergeable(data, head, base));
  });
}

test('uses the latest independent-review status, not an older success', () => {
  const data = fixture();
  data.statuses.unshift({ context: REVIEW_CONTEXT, state: 'pending' });
  assert.throws(() => assertMergeable(data, head, base));
});

test('accepts a resolved change request but not a merely pending review', () => {
  const data = fixture();
  data.reviews = [
    { user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' },
    { user: { login: 'reviewer' }, state: 'PENDING' },
  ];
  assert.throws(() => assertMergeable(data, head, base));
  data.reviews.push({ user: { login: 'reviewer' }, state: 'APPROVED' });
  assert.doesNotThrow(() => assertMergeable(data, head, base));
});

test('a comment-only review does not clear an earlier change request', () => {
  const data = fixture();
  data.reviews = [
    { user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED' },
    { user: { login: 'reviewer' }, state: 'COMMENTED' },
  ];
  assert.throws(() => assertMergeable(data, head, base));
});

test('squash request pins head, uses noreply identity and a fixed body', () => {
  const pr = { number: 7, node_id: 'PR_x', title: 'Add thing' };
  const request = squashRequest(pr, head, noreply);
  assert.equal(request.expectedHeadOid, head);
  assert.equal(request.authorEmail, noreply);
  assert.equal(request.mergeMethod, 'SQUASH');
  assert.equal(request.commitHeadline, 'Add thing (#7)');
  assert.ok(request.commitBody.endsWith(COPILOT_TRAILER));
});

test('squash request rejects a non-noreply identity and email-bearing titles', () => {
  const pr = { number: 7, node_id: 'PR_x', title: `Fix by ${personal}` };
  assert.throws(() => squashRequest(pr, head, personal));
  assert.doesNotMatch(squashRequest(pr, head, noreply).commitHeadline, /@/);
});
