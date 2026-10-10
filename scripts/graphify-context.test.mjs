import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { build, ContextError, ensure, EXIT, graphProblem, inspect, main } from './graphify-context.mjs';

const helper = join(dirname(new URL(import.meta.url).pathname), 'graphify-context.mjs');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.fsmonitor=false', ...args], {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
});

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

const GOOD = '{"nodes":[{"id":"a"},{"id":"b"}],"links":[{"source":"a","target":"b"}]}';
// Fake local tool; records its environment and arguments in calls.log.
function fakeTool(dir, { name = 'fake-graphify', body = '', version = '1.0.0', graph = GOOD } = {}) {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "graphify ${version}"; exit 0; fi
echo "$GRAPHIFY_NO_AUTO_REFRESH|$OPENAI_API_KEY|$HOME|$(ls -A "$HOME" | wc -l | tr -d ' ')|$PATH|$*" >> "${dir}/calls.log"
${body}
out=""; src="$2"; while [ $# -gt 0 ]; do [ "$1" = "--out" ] && out="$2"; shift; done
mkdir -p "$out/graphify-out"
printf '%s' '${graph}' > "$out/graphify-out/graph.json"
`);
  chmodSync(path, 0o755);
  return path;
}
const calls = (dir) => (existsSync(join(dir, 'calls.log')) ? readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n') : []);
const args = (repo, out, bin, extra = {}) => ({ cwd: repo, out, mode: 'committed', rev: 'HEAD', bin, pathEnv: '', ...extra });
const current = (out) => realpathSync(join(out, 'current'));
const generations = (out) => readdirSync(out).filter((name) => name.startsWith('gen-'));

test('builds a committed snapshot, reuses it while fresh and keeps the worktree clean', (t) => {
  const { dir, repo, out } = workspace(t);
  const bin = fakeTool(dir);
  const first = main(['ensure', '--out', out, '--task', 'demo'], repo, { GRAPHIFY_BIN: bin });
  assert.equal(first.code, EXIT.ok);
  assert.match(first.line, /task=demo; graph=built; evidence=committed-snapshot; commit=[0-9a-f]{40}; graph-json=.*graph\.json; provenance=/);
  assert.match(main(['ensure', '--out', out], repo, { GRAPHIFY_BIN: bin }).line, /graph=fresh/);
  assert.equal(calls(dir).length, 1);
  assert.equal(git(repo, 'status', '--porcelain'), '');
  assert.equal(generations(out).length, 1);
});

test('extraction runs with an owned empty HOME, no credentials and a bounded PATH', (t) => {
  const { dir, repo, out } = workspace(t);
  process.env.OPENAI_API_KEY = 'secret';
  t.after(() => { delete process.env.OPENAI_API_KEY; });
  build(args(repo, out, fakeTool(dir)));
  const [call] = calls(dir);
  const [flag, key, home, entries, path, ...rest] = call.split('|');
  assert.equal(flag, '1');
  assert.equal(key, '');
  assert.notEqual(home, process.env.HOME);
  assert.equal(entries, '0');
  assert.equal(path, `${dir}:/usr/bin:/bin`);
  assert.match(rest.join('|'), /^extract .*\/source --code-only --max-workers 2 --out /);
});

test('revision, tool version and same-path same-version replacement make the graph stale', (t) => {
  const { dir, repo, out } = workspace(t);
  const bin = fakeTool(dir);
  const a = args(repo, out, bin);
  build(a);
  writeFileSync(join(repo, 'a.ts'), 'export const a = 3;\n');
  git(repo, 'commit', '-qam', 'two');
  assert.match(inspect(a).reason, /commit/);
  build(a);
  assert.equal(inspect(a).status, 'fresh');
  assert.match(inspect(args(repo, out, fakeTool(dir, { version: '2.0.0' }))).reason, /tool/);
  fakeTool(dir, { body: '# replaced bytes, same version' });
  assert.match(inspect(a).reason, /tool/);
  assert.equal(ensure(a).status, 'built');
});

test('committed mode ignores edits; worktree mode is labelled dirty and tracks add/delete/edit', (t) => {
  const { dir, repo, out } = workspace(t);
  const bin = fakeTool(dir);
  build(args(repo, out, bin));
  writeFileSync(join(repo, 'a.ts'), 'export const a = 9;\n');
  assert.equal(inspect(args(repo, out, bin)).status, 'fresh');

  const dirtyOut = join(dir, 'artifacts', 'dirty');
  const dirty = args(repo, dirtyOut, bin, { mode: 'worktree' });
  assert.equal(build(dirty).provenance.evidence, 'dirty-worktree-not-exact-head');
  assert.equal(inspect(dirty).status, 'fresh');
  writeFileSync(join(repo, 'new.ts'), 'export const n = 1;\n');
  assert.equal(inspect(dirty).status, 'stale');
  build(dirty);
  rmSync(join(repo, 'b.ts'));
  assert.equal(inspect(dirty).status, 'stale');
  build(dirty);
  assert.equal(existsSync(join(current(dirtyOut), 'source', 'b.ts')), false);
  assert.equal(readFileSync(join(current(dirtyOut), 'source', 'a.ts'), 'utf8'), 'export const a = 9;\n');
  assert.equal(inspect(dirty).status, 'fresh');
});

test('Git path bytes are preserved: leading space and newline filenames', (t) => {
  const { dir, repo, out } = workspace(t);
  writeFileSync(join(repo, ' sp.ts'), 'export const s = 1;\n');
  writeFileSync(join(repo, 'new\nline.ts'), 'export const n = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'odd names');
  const bin = fakeTool(dir);
  build(args(repo, out, bin));
  assert.ok(existsSync(join(current(out), 'source', ' sp.ts')));
  assert.ok(existsSync(join(current(out), 'source', 'new\nline.ts')));
  const dirty = args(repo, join(dir, 'artifacts', 'dirty'), bin, { mode: 'worktree' });
  writeFileSync(join(repo, ' sp.ts'), 'export const s = 2;\n');
  writeFileSync(join(repo, ' untracked.ts'), 'export const u = 1;\n');
  build(dirty);
  const source = join(current(dirty.out), 'source');
  assert.equal(readFileSync(join(source, ' sp.ts'), 'utf8'), 'export const s = 2;\n');
  assert.ok(existsSync(join(source, ' untracked.ts')));
});

test('export-ignore cannot omit tracked files from a committed snapshot', (t) => {
  const { dir, repo, out } = workspace(t);
  writeFileSync(join(repo, '.gitattributes'), 'hidden.ts export-ignore\n');
  writeFileSync(join(repo, 'hidden.ts'), 'export const h = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'attrs');
  const { provenance } = build(args(repo, out, fakeTool(dir)));
  assert.ok(existsSync(join(current(out), 'source', 'hidden.ts')));
  assert.match(provenance.snapshotSha256, /^[0-9a-f]{64}$/);
  assert.match(provenance.tree, /^[0-9a-f]{40}$/);
});

test('symlinks are excluded and counted; ancestor symlinks are never read', (t) => {
  const { dir, repo, out } = workspace(t);
  const bin = fakeTool(dir);
  symlinkSync('/etc', join(repo, 'link'));
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'link');
  const result = build(args(repo, out, bin));
  assert.equal(existsSync(join(current(out), 'source', 'link')), false);
  assert.equal(result.provenance.excludedSymlinksOrSubmodules, 1);

  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src', 'x.ts'), 'export const x = 1;\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'src');
  const external = join(dir, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'x.ts'), 'export const SECRET = 1;\n');
  rmSync(join(repo, 'src'), { recursive: true });
  symlinkSync(external, join(repo, 'src'));
  const dirtyOut = join(dir, 'artifacts', 'dirty');
  assert.throws(() => build(args(repo, dirtyOut, bin, { mode: 'worktree' })), /traverses a symlink/);
  assert.equal(existsSync(join(dirtyOut, 'current')), false);
  assert.deepEqual(generations(dirtyOut), []);
});

test('failures keep the last complete generation (extraction, snapshot, source change, bad graph)', (t) => {
  const { dir, repo, out } = workspace(t);
  const good = fakeTool(dir);
  build(args(repo, out, good));
  const before = current(out);
  const snapshot = readFileSync(join(before, 'provenance.json'), 'utf8');
  writeFileSync(join(repo, 'a.ts'), 'export const a = 3;\n');
  git(repo, 'commit', '-qam', 'two');
  const attempts = [
    [fakeTool(dir, { name: 'f1', body: 'exit 4' }), /extraction failed/],
    [fakeTool(dir, { name: 'f2', body: 'exit 0' }), /no graph.json|previous graph kept/],
    [fakeTool(dir, { name: 'f3', graph: 'not json' }), /not valid JSON/],
    [fakeTool(dir, { name: 'f4', body: `git -C "${repo}" -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false commit -q --allow-empty -m race` }), /source changed during the build/],
  ];
  for (const [bin, message] of attempts) {
    assert.throws(() => build(args(repo, out, bin)), message);
    assert.equal(current(out), before);
    assert.equal(readFileSync(join(before, 'provenance.json'), 'utf8'), snapshot);
    assert.deepEqual(generations(out), [before.split('/').pop()]);
  }
  assert.equal(inspect(args(repo, out, good)).status, 'stale');
});

test('mid-build edits of a dirty worktree are detected', (t) => {
  const { dir, repo, out } = workspace(t);
  const body = `echo 'export const a = 7;' > "${repo}/a.ts"`;
  assert.throws(() => build(args(repo, out, fakeTool(dir, { body }), { mode: 'worktree' })), /source changed during the build/);
  assert.equal(existsSync(join(out, 'current')), false);
});

test('overlapping builds are serialized and publish a matching graph and provenance', async (t) => {
  const { dir, repo, out } = workspace(t);
  const slowA = fakeTool(dir, { name: 'tool-a', body: 'sleep 1', graph: '{"nodes":[{"id":"A"}],"links":[]}' });
  const toolB = fakeTool(dir, { name: 'tool-b', graph: '{"nodes":[{"id":"B"}],"links":[]}' });
  const run = (bin) => new Promise((resolveRun) => {
    const child = spawn(process.execPath, [helper, 'ensure', '--out', out], { cwd: repo, env: { ...process.env, GRAPHIFY_BIN: bin } });
    child.on('close', resolveRun);
  });
  const [codeA, codeB] = await Promise.all([run(slowA), run(toolB)]);
  assert.deepEqual([codeA, codeB], [0, 0]);
  const gen = current(out);
  const provenance = JSON.parse(readFileSync(join(gen, 'provenance.json'), 'utf8'));
  const graph = readFileSync(join(gen, 'graph', 'graphify-out', 'graph.json'));
  assert.equal(provenance.graphSha256, execFileSync('shasum', ['-a', '256'], { input: graph }).toString().split(' ')[0]);
  assert.equal(generations(out).length, 1);
  assert.equal(existsSync(join(out, '.lock')), false);
  const winner = JSON.parse(graph.toString()).nodes[0].id === 'A' ? slowA : toolB;
  assert.equal(inspect(args(repo, out, winner)).status, 'fresh');
});

test('output containment: inside, dotted sibling name, symlink alias, ancestor of the repo, foreign contents', (t) => {
  const { dir, repo } = workspace(t);
  const bin = fakeTool(dir);
  const refuse = (out, message) => assert.throws(() => build(args(repo, out, bin)), message);
  refuse(join(repo, '..graph-artifacts'), /outside the repository/);
  refuse(join(repo, 'sub', 'out'), /outside the repository/);
  symlinkSync(repo, join(dir, 'alias'));
  refuse(join(dir, 'alias', 'out'), /outside the repository/);
  writeFileSync(join(dir, MARKER_NAME), 'x');
  refuse(dir, /outside the repository|must not contain/);
  assert.ok(existsSync(join(repo, 'a.ts')));
  assert.ok(existsSync(join(repo, '.git')));
  const foreign = join(dir, 'precious');
  mkdirSync(foreign);
  writeFileSync(join(foreign, 'keep.txt'), 'x');
  refuse(foreign, /not a graphify-context directory/);
  const owned = join(dir, 'owned');
  build(args(repo, owned, bin));
  writeFileSync(join(owned, 'user-note.txt'), 'x');
  build(args(repo, owned, bin));
  assert.ok(existsSync(join(owned, 'user-note.txt')));
  assert.throws(() => main(['ensure', '--out', 'relative'], repo), /absolute/);
  assert.equal(git(repo, 'status', '--porcelain'), '');
});
const MARKER_NAME = '.graphify-context';

test('tools resolving inside the repository are rejected before execution', (t) => {
  const { dir, repo, out } = workspace(t);
  const inRepo = fakeTool(repo, { name: 'graphify' });
  const { pathEnv, ...rest } = args(repo, out, 'graphify');
  assert.throws(() => inspect({ ...rest, pathEnv: repo }), /inside the repository/);
  assert.throws(() => build({ ...rest, bin: inRepo }), /inside the repository/);
  const alias = join(dir, 'bin');
  mkdirSync(alias);
  symlinkSync(inRepo, join(alias, 'graphify'));
  assert.throws(() => inspect({ ...rest, pathEnv: alias }), /inside the repository/);
  assert.equal(existsSync(join(repo, 'calls.log')) || existsSync(join(dir, 'calls.log')), false);
});

test('graph structure validation', () => {
  const problem = (value) => graphProblem(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  assert.equal(problem({ nodes: [{ id: 'a' }], links: [] }), null);
  assert.ok(problem({ nodes: [null], links: 'broken' }));
  assert.ok(problem({ nodes: [{ id: 'a' }], links: 'broken' }));
  assert.ok(problem({ nodes: [{ id: 'a' }], links: [{ source: 'a', target: 'z' }] }));
  assert.ok(problem({ nodes: [{ id: 'a' }, { id: 'a' }], links: [] }));
  assert.ok(problem({ nodes: [{}], links: [] }));
  assert.ok(problem({ nodes: [], links: [] }));
  assert.ok(problem('[]'));
});

test('later graph corruption, deletion or provenance damage is detected', (t) => {
  const { dir, repo, out } = workspace(t);
  const a = args(repo, out, fakeTool(dir));
  build(a);
  const gen = current(out);
  const graph = join(gen, 'graph', 'graphify-out', 'graph.json');
  const original = readFileSync(graph);
  writeFileSync(graph, '{"nodes":[null],"links":"broken"}');
  assert.match(inspect(a).reason, /changed since/);
  rmSync(graph);
  assert.match(inspect(a).reason, /missing/);
  writeFileSync(graph, original);
  writeFileSync(join(gen, 'provenance.json'), '{');
  assert.match(inspect(a).reason, /corrupt/);
});

test('missing tool is reported plainly; status never builds', (t) => {
  const { dir, repo, out } = workspace(t);
  assert.throws(() => main(['status', '--out', out], repo, { GRAPHIFY_BIN: join(dir, 'nope') }), (error) => {
    assert.ok(error instanceof ContextError);
    assert.equal(error.code, EXIT.missingTool);
    assert.match(error.message, /direct source search/);
    return true;
  });
  const result = main(['status', '--out', out], repo, { GRAPHIFY_BIN: fakeTool(dir) });
  assert.equal(result.code, EXIT.stale);
  assert.match(result.line, /graph=missing/);
  assert.equal(existsSync(out), false);
});

const liveBin = (process.env.PATH ?? '').split(delimiter).map((d) => join(d, 'graphify')).concat(`${process.env.HOME}/.local/bin/graphify`)
  .find((p) => existsSync(p));
test('live graphify smoke on an owned fixture in a credential- and settings-free environment',
  { skip: liveBin ? false : 'graphify not installed' }, (t) => {
    const { repo, out } = workspace(t);
    writeFileSync(join(repo, 'a.ts'), 'export function a(){return b();}\nexport function b(){return 1;}\n');
    git(repo, 'commit', '-qam', 'fn');
    const env = { GRAPHIFY_BIN: liveBin, PATH: '/usr/bin:/bin' };
    assert.match(main(['ensure', '--out', out], repo, env).line, /graph=built/);
    assert.match(main(['ensure', '--out', out], repo, env).line, /graph=fresh/);
  });
