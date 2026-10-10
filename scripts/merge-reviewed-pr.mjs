import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'futuleo/mac-file-manager';
export const REVIEW_CONTEXT = 'agent/independent-review';

export function assertMergeable({ pr, mainSha, statuses, checks, reviews, threads }, head, base) {
  const require = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  require(pr.state === 'open' && !pr.draft, 'PR must be open and ready for review.');
  require(pr.base.ref === 'main' && pr.base.repo.full_name === REPOSITORY
    && pr.head.repo?.full_name === REPOSITORY, 'Unexpected repository or target branch.');
  require(pr.head.sha === head, 'PR head changed; repeat validation and review.');
  require(mainSha === base, 'main changed; update the branch and repeat validation and review.');
  const review = statuses.find((status) => status.context === REVIEW_CONTEXT);
  require(review?.state === 'success' && review.description === `Reviewed base ${base}`,
    'Missing successful independent review of this exact head and base.');
  const validation = checks.filter((check) => check.name === 'validate')
    .sort((a, b) => b.id - a.id)[0];
  require(validation?.app?.slug === 'github-actions'
    && validation.status === 'completed' && validation.conclusion === 'success',
  'The newest validate check must be a successful GitHub Actions run.');
  const latestReviews = new Map();
  for (const item of reviews) {
    if (item.state === 'CHANGES_REQUESTED' || item.state === 'APPROVED' || item.state === 'DISMISSED') {
      latestReviews.set(item.user.login, item.state);
    }
  }
  require(![...latestReviews.values()].includes('CHANGES_REQUESTED'),
    'A reviewer is still requesting changes.');
  require(!threads.pageInfo.hasNextPage, 'Too many review threads; manual inspection required.');
  require(threads.nodes.every((thread) => thread.isResolved), 'Unresolved review threads remain.');
  require(pr.mergeable === true && pr.mergeable_state === 'clean',
    'GitHub does not report a clean, mergeable PR.');
}

function api(endpoint, extra = [], input) {
  return JSON.parse(execFileSync('gh', ['api', endpoint, ...extra], {
    encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'],
  }));
}

export function mergeReviewedPr(number, head, base) {
  if (!/^[1-9]\d*$/.test(number) || !/^[a-f0-9]{40}$/.test(head) || !/^[a-f0-9]{40}$/.test(base)) {
    throw new Error('Usage: node scripts/merge-reviewed-pr.mjs <pr-number> <full-head-sha> <full-main-sha>');
  }
  const root = `repos/${REPOSITORY}`;
  const pr = api(`${root}/pulls/${number}`);
  const main = api(`${root}/git/ref/heads/main`);
  const statuses = api(`${root}/commits/${head}/status`).statuses;
  const checks = api(`${root}/commits/${head}/check-runs`, ['--paginate', '--slurp'])
    .flatMap((page) => page.check_runs);
  const reviews = api(`${root}/pulls/${number}/reviews`, ['--paginate', '--slurp']).flat();
  const query = `query($number:Int!) {
    repository(owner:"futuleo",name:"mac-file-manager") {
      pullRequest(number:$number) {
        reviewThreads(first:100) { nodes { isResolved } pageInfo { hasNextPage } }
      }
    }
  }`;
  const graph = api('graphql', ['-f', `query=${query}`, '-F', `number=${number}`]);
  if (graph.errors) throw new Error(`Review-thread query failed: ${JSON.stringify(graph.errors)}`);
  assertMergeable({
    pr, mainSha: main.object.sha, statuses, checks, reviews,
    threads: graph.data.repository.pullRequest.reviewThreads,
  }, head, base);
  const result = api(`${root}/pulls/${number}/merge`, ['--method', 'PUT', '--input', '-'],
    JSON.stringify({ sha: head, merge_method: 'squash' }));
  if (!result.merged) throw new Error(`GitHub refused merge: ${result.message}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [number, head, base] = process.argv.slice(2);
    console.log(JSON.stringify(mergeReviewedPr(number, head, base)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
