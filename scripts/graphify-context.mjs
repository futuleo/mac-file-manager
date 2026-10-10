import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  realpathSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional, on-demand, local-only graph freshness helper. A graph is navigation, never evidence.
const MARKER = '.graphify-context';
const PROVENANCE = 'provenance.json';
const EXTRACT_ARGS = ['--code-only', '--max-workers', '2'];
const SCHEMA = 1;
export const EXIT = { ok: 0, failure: 1, stale: 2, missingTool: 3 };

export class ContextError extends Error {
  constructor(message, code = EXIT.failure) {
    super(message);
    this.code = code;
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();

function toolEnv() {
  // No provider credentials or settings: only what a local process needs to run.
  const env = { GRAPHIFY_NO_AUTO_REFRESH: '1' };
  for (const key of ['PATH', 'HOME', 'LANG', 'TMPDIR']) if (process.env[key]) env[key] = process.env[key];
  return env;
}

function findTool(bin) {
  const candidates = bin.includes(sep) ? [bin]
    : (process.env.PATH ?? '').split(':').filter(Boolean).map((dir) => join(dir, bin));
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new ContextError(`graphify is not installed (optional); use direct source search instead of a graph.`,
      EXIT.missingTool);
  }
  const path = realpathSync(found);
  const result = spawnSync(path, ['--version'], { encoding: 'utf8', env: toolEnv() });
  if (result.status !== 0) throw new ContextError('graphify --version failed; treat the graph as unavailable.');
  return { path, version: result.stdout.trim(), identity: sha256(path).slice(0, 16) };
}

function repoRoot(cwd) {
  return realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
}

function assertOutside(out, root) {
  const rel = relative(root, out);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new ContextError('--out must be outside the repository worktree (use a session artifact directory).');
  }
}

// Fingerprint regular files only (symlinks are never followed or indexed).
function fingerprintFiles(base, files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const full = join(base, file);
    const stat = lstatSync(full);
    if (!stat.isFile()) continue;
    hash.update(`${file}\0${sha256(readFileSync(full))}\n`);
  }
  return hash.digest('hex');
}

function worktreeFiles(root) {
  const listed = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0').filter(Boolean);
  // Deleted tracked files are listed but absent; they are simply not part of the source.
  return listed.filter((file) => {
    try {
      return lstatSync(join(root, file)).isFile();
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  });
}

function sourceState(root, mode, rev) {
  const head = git(root, ['rev-parse', '--verify', `${rev}^{commit}`]);
  const dirty = git(root, ['status', '--porcelain=v1', '--untracked-files=all']).length > 0;
  if (mode === 'worktree') {
    return { commit: head, dirty, fingerprint: fingerprintFiles(root, worktreeFiles(root)) };
  }
  return { commit: head, dirty, fingerprint: head };
}

function expectedKey(root, mode, rev, tool) {
  const state = sourceState(root, mode, rev);
  return {
    schema: SCHEMA,
    mode,
    evidence: mode === 'worktree' ? 'dirty-worktree-not-exact-head' : 'committed-snapshot',
    repoRoot: root,
    commit: state.commit,
    sourceFingerprint: state.fingerprint,
    worktreeDirtyAtCheck: state.dirty,
    tool: { version: tool.version, identity: tool.identity },
    extractArgs: EXTRACT_ARGS,
  };
}

const KEY_FIELDS = ['schema', 'mode', 'evidence', 'repoRoot', 'commit', 'sourceFingerprint', 'tool', 'extractArgs'];

function graphProblem(out, provenance) {
  const graph = join(out, 'graph', 'graphify-out', 'graph.json');
  if (!existsSync(graph)) return 'graph output is missing';
  const bytes = readFileSync(graph);
  if (sha256(bytes) !== provenance.graphSha256) return 'graph output changed since it was built';
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'graph output is not valid JSON';
  }
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length === 0) return 'graph output has no nodes';
  return null;
}

export function inspect({ cwd, out, mode, rev, bin }) {
  const root = repoRoot(cwd);
  assertOutside(out, root);
  const tool = findTool(bin);
  const path = join(out, PROVENANCE);
  if (!existsSync(path)) return { status: 'missing', reason: 'no provenance for this output', root };
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { status: 'stale', reason: 'provenance is corrupt', root };
  }
  const want = expectedKey(root, mode, rev, tool);
  const stale = KEY_FIELDS.filter((field) => JSON.stringify(provenance[field]) !== JSON.stringify(want[field]));
  if (stale.length > 0) return { status: 'stale', reason: `changed: ${stale.join(', ')}`, root, provenance, want };
  const problem = graphProblem(out, provenance);
  if (problem) return { status: 'stale', reason: problem, root, provenance, want };
  return { status: 'fresh', root, provenance, want };
}

function removeSymlinks(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) unlinkSync(full);
    else if (entry.isDirectory()) removeSymlinks(full);
  }
}

function snapshot(root, out, mode, commit) {
  const target = join(out, 'source');
  mkdirSync(target, { recursive: true });
  if (mode === 'committed') {
    const tar = execFileSync('git', ['archive', '--format=tar', commit], { cwd: root, maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', target], { input: tar });
    removeSymlinks(target);
    return fingerprintFiles(target, listTree(target));
  }
  const files = worktreeFiles(root);
  for (const file of files) {
    const dest = join(target, file);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(join(root, file), dest);
  }
  return fingerprintFiles(target, files);
}

function listTree(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listTree(join(dir, entry.name), name) : [name];
  });
}

function prepareOutput(out) {
  if (existsSync(out)) {
    const entries = readdirSync(out);
    if (entries.length > 0 && !entries.includes(MARKER)) {
      throw new ContextError('--out exists, is not empty and is not a graphify-context directory; refusing to overwrite.');
    }
    for (const entry of entries) rmSync(join(out, entry), { recursive: true, force: true });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, MARKER), 'managed by scripts/graphify-context.mjs\n');
}

export function build({ cwd, out, mode, rev, bin }) {
  const root = repoRoot(cwd);
  assertOutside(out, root);
  const tool = findTool(bin);
  const before = expectedKey(root, mode, rev, tool);
  prepareOutput(out);

  const copied = snapshot(root, out, mode, before.commit);
  const after = expectedKey(root, mode, rev, tool);
  if (after.sourceFingerprint !== before.sourceFingerprint || (mode === 'worktree' && copied !== before.sourceFingerprint)) {
    throw new ContextError('source changed while the snapshot was taken; nothing was published. Retry at a quiet moment.');
  }

  const result = spawnSync(tool.path, ['extract', join(out, 'source'), ...EXTRACT_ARGS, '--out', join(out, 'graph')], {
    encoding: 'utf8', env: toolEnv(), cwd: out,
  });
  if (result.status !== 0) {
    throw new ContextError(`graphify extraction failed (exit ${result.status}); no graph was published.`);
  }
  const written = sourceFingerprintOf(join(out, 'source'));
  if (written !== copied) throw new ContextError('snapshot changed during extraction; no graph was published.');

  const final = expectedKey(root, mode, rev, tool);
  if (final.sourceFingerprint !== before.sourceFingerprint) {
    throw new ContextError('source changed during the build; no graph was published. Rebuild when work is quiet.');
  }

  const graphPath = join(out, 'graph', 'graphify-out', 'graph.json');
  if (!existsSync(graphPath)) throw new ContextError('graphify produced no graph.json; no graph was published.');
  const bytes = readFileSync(graphPath);
  const provenance = { ...final, builtAt: new Date().toISOString(), graphSha256: sha256(bytes) };
  const problem = graphProblem(out, provenance);
  if (problem) throw new ContextError(`${problem}; no graph was published.`);
  writeFileSync(join(out, PROVENANCE), `${JSON.stringify(provenance, null, 2)}\n`);
  return { status: 'built', root, provenance, want: final };
}

function sourceFingerprintOf(dir) {
  return fingerprintFiles(dir, listTree(dir));
}

export function handoffLine({ status, reason, provenance, want }, out, task) {
  const key = provenance ?? want;
  const parts = [`graph=${status}${reason ? ` (${reason})` : ''}`];
  if (key) {
    parts.push(`evidence=${key.evidence}`, `commit=${key.commit}`,
      `graph=${join(out, 'graph', 'graphify-out', 'graph.json')}`, `provenance=${join(out, PROVENANCE)}`);
  }
  if (task) parts.unshift(`task=${task}`);
  return parts.join('; ');
}

function parseArgs(argv, env) {
  const [command, ...rest] = argv;
  const options = { mode: 'committed', rev: 'HEAD', task: '', bin: env.GRAPHIFY_BIN ?? 'graphify' };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag === '--worktree') options.mode = 'worktree';
    else if (['--out', '--rev', '--task'].includes(flag)) {
      if (rest[i + 1] === undefined) throw new ContextError(`${flag} needs a value`);
      options[flag.slice(2)] = rest[i + 1];
      i += 1;
    } else throw new ContextError(`unknown option ${flag}`);
  }
  if (!['status', 'ensure'].includes(command)) throw new ContextError(usage());
  if (!options.out || !isAbsolute(options.out)) throw new ContextError(`--out must be an absolute path\n${usage()}`);
  if (options.mode === 'worktree' && options.rev !== 'HEAD') throw new ContextError('--rev cannot be combined with --worktree');
  options.out = resolve(options.out);
  return { command, options };
}

const usage = () => 'usage: graphify-context.mjs <status|ensure> --out ABS_DIR [--rev REV | --worktree] [--task TEXT]\n'
  + '  default: committed snapshot (exact commit evidence); --worktree: dirty snapshot, never exact-head evidence.';

export function main(argv, cwd = process.cwd(), env = process.env) {
  const { command, options } = parseArgs(argv, env);
  const args = { cwd, ...options };
  let result = inspect(args);
  if (command === 'ensure' && result.status !== 'fresh') result = build(args);
  const line = handoffLine(result, options.out, options.task);
  return { code: result.status === 'fresh' || result.status === 'built' ? EXIT.ok : EXIT.stale, line };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const { code, line } = main(process.argv.slice(2));
    console.log(line);
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof ContextError)) throw error;
    console.error(error.message);
    process.exitCode = error.code;
  }
}
