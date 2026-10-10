import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { build, ContextError, EXIT, inspect, main } from './graphify-context.mjs';

const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', ...args], { cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();

function workspace(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gfx-test-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(repo, 'b.ts'), 'export const b = 2;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'one');
  return { dir, repo, out: join(dir, 'artifacts', 'graph') };
}

// Fake local tool: records its environment and extract arguments, then writes a graph.
function fakeTool(dir, { body = '', version = '1.0.0', graph = '{"nodes":[{"id":"a"}],"links":[]}' } = {}) {
  const path = join(dir, 'fake-graphify');
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "graphify ${version}"; exit 0; fi
echo "$GRAPHIFY_NO_AUTO_REFRESH|$OPENAI_API_KEY|$*" >> "${dir}/calls.log"
${body}
out=""; while [ $# -gt 0 ]; do [ "$1" = "--out" ] && out="$2"; shift; done
mkdir -p "$out/graphify-out"
printf '%s' '${graph}' > "$out/graphify-out/graph.json"
`);
  chmodSync(path, 0o755);
  return path;
}

const calls = (dir) => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : []);

test('builds a committed snapshot, then reuses it while fresh', (t) => {
  const { dir, repo, out } = workspace(t);
  const bin = fakeTool(dir);
  const first = main(['ensure', '--out', out, '--task', 'demo'], repo, { GRAPHIFY_BIN: bin });
  assert.equal(first.code, EXIT.ok);
  assert.match(first.line, /task=demo; graph=built; evidence=committed-snapshot/);
  const second = main(['ensure', '--out', out], repo, { GRAPHIFY_BIN: bin });
  assert.match(second.line, /graph=fresh/);
  assert.equal(calls(dir).length, 1);
  assert.equal(existsSync(join(repo, 'graphify-out')), false);
});

test('extraction is local, credential-free and bounded', (t) => {
  const { dir, repo, out } = workspace(t);
  process.env.OPENAI_API_KEY = 'secret';
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  build({ cwd: repo, out, mode: 'committed', rev: 'HEAD', bin: fakeTool(dir) });
  const [call] = calls(dir);
  assert.match(call, /^1\|\|extract .*\/source --code-only --max-workers 2 --out /);
});

test('revision mismatch and tool version change make the graph stale', (t) => {
  const { dir, repo, out } = workspace(t);
  const bin = fakeTool(dir);
  const args = { cwd: repo, out, mode: 'committed', rev: 'HEAD', bin };
  build(args);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 3;\n');
  git(repo, 'commit', '-qam', 'two');
  const stale = inspect(args);
  assert.equal(stale.status, 'stale');
  assert.match(stale.reason, /commit/);
  build(args);
  assert.equal(inspect(args).status, 'fresh');
  const upgraded = fakeTool(dir, { version: '2.0.0' });
  assert.match(inspect({ ...args, bin: upgraded }).reason, /tool/);
});

test('committed mode ignores uncommitted edits; worktree mode is labelled dirty and tracks them', (t) => {
  const { dir, repo, out } = workspace(t);
  const bin = fakeTool(dir);
  const committed = { cwd: repo, out, mode: 'committed', rev: 'HEAD', bin };
  build(committed);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 9;\n');
  assert.equal(inspect(committed).status, 'fresh');

  const dirtyOut = join(dir, 'artifacts', 'dirty');
  const dirty = { cwd: repo, out: dirtyOut, mode: 'worktree', rev: 'HEAD', bin };
  assert.equal(build(dirty).provenance.evidence, 'dirty-worktree-not-exact-head');
  assert.equal(inspect(dirty).status, 'fresh');
  writeFileSync(join(repo, 'new.ts'), 'export const n = 1;\n');
  assert.equal(inspect(dirty).status, 'stale');
  build(dirty);
  rmSync(join(repo, 'b.ts'));
  assert.equal(inspect(dirty).status, 'stale');
  build(dirty);
  assert.equal(existsSync(join(dirtyOut, 'source', 'b.ts')), false);
  assert.equal(inspect(dirty).status, 'fresh');
});

test('symlinks are not indexed', (t) => {
  const { dir, repo, out } = workspace(t);
  symlinkSync('/etc', join(repo, 'link'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'link');
  build({ cwd: repo, out, mode: 'committed', rev: 'HEAD', bin: fakeTool(dir) });
  assert.equal(existsSync(join(out, 'source', 'link')), false);
});

test('extraction failure, missing output and corrupt graph publish nothing', (t) => {
  const { dir, repo, out } = workspace(t);
  const args = { cwd: repo, out, mode: 'committed', rev: 'HEAD' };
  assert.throws(() => build({ ...args, bin: fakeTool(dir, { body: 'exit 4' }) }), /extraction failed/);
  assert.throws(() => build({ ...args, bin: fakeTool(dir, { body: 'exit 0' }) }), /no graph.json|graph output/);
  assert.throws(() => build({ ...args, bin: fakeTool(dir, { graph: 'not json' }) }), /not valid JSON/);
  assert.throws(() => build({ ...args, bin: fakeTool(dir, { graph: '{"nodes":[]}' }) }), /no nodes/);
  assert.equal(existsSync(join(out, 'provenance.json')), false);
  assert.equal(inspect({ ...args, bin: fakeTool(dir) }).status, 'missing');
});

test('later corruption or deletion of the graph is detected', (t) => {
  const { dir, repo, out } = workspace(t);
  const args = { cwd: repo, out, mode: 'committed', rev: 'HEAD', bin: fakeTool(dir) };
  build(args);
  const graph = join(out, 'graph', 'graphify-out', 'graph.json');
  writeFileSync(graph, '{"nodes":[{"id":"x"}]}');
  assert.match(inspect(args).reason, /changed since/);
  rmSync(graph);
  assert.match(inspect(args).reason, /missing/);
  writeFileSync(join(out, 'provenance.json'), '{');
  assert.match(inspect(args).reason, /corrupt/);
});

test('detects source changes during the build', (t) => {
  const { dir, repo, out } = workspace(t);
  const body = `echo 'export const a = 7;' > "${repo}/a.ts"`;
  const args = { cwd: repo, out, mode: 'worktree', rev: 'HEAD', bin: fakeTool(dir, { body }) };
  assert.throws(() => build(args), /source changed during the build/);
  assert.equal(existsSync(join(out, 'provenance.json')), false);
});

test('output must be isolated and never overwrites unrelated directories', (t) => {
  const { dir, repo } = workspace(t);
  const bin = fakeTool(dir);
  assert.throws(() => build({ cwd: repo, out: join(repo, 'graph-out'), mode: 'committed', rev: 'HEAD', bin }), /outside the repository/);
  const other = join(dir, 'precious');
  mkdirSync(other);
  writeFileSync(join(other, 'keep.txt'), 'x');
  assert.throws(() => build({ cwd: repo, out: other, mode: 'committed', rev: 'HEAD', bin }), /refusing to overwrite/);
  assert.equal(existsSync(join(other, 'keep.txt')), true);
  assert.throws(() => main(['ensure', '--out', 'relative'], repo), /absolute/);
});

test('missing tool is reported plainly with the direct-search fallback', (t) => {
  const { dir, repo, out } = workspace(t);
  assert.throws(() => main(['status', '--out', out], repo, { GRAPHIFY_BIN: join(dir, 'nope') }), (error) => {
    assert.ok(error instanceof ContextError);
    assert.equal(error.code, EXIT.missingTool);
    assert.match(error.message, /direct source search/);
    return true;
  });
});

test('status never builds and reports missing', (t) => {
  const { dir, repo, out } = workspace(t);
  const result = main(['status', '--out', out], repo, { GRAPHIFY_BIN: fakeTool(dir) });
  assert.equal(result.code, EXIT.stale);
  assert.match(result.line, /graph=missing/);
  assert.equal(existsSync(out), false);
});

const live = (() => {
  try { return execFileSync('graphify', ['--version'], { encoding: 'utf8' }).trim(); } catch { return null; }
})();
test('live graphify smoke on an owned fixture', { skip: live ? false : 'graphify not installed' }, (t) => {
  const { repo, out } = workspace(t);
  writeFileSync(join(repo, 'a.ts'), 'export function a(){return b();}\nexport function b(){return 1;}\n');
  git(repo, 'commit', '-qam', 'fn');
  const args = { cwd: repo, out, mode: 'committed', rev: 'HEAD', bin: 'graphify' };
  assert.equal(build(args).status, 'built');
  assert.equal(inspect(args).status, 'fresh');
});
