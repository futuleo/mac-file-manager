import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  accessSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  readlinkSync, readSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Optional, on-demand, local-only graph freshness helper. A graph is navigation, never evidence.
// Each build is staged in its own generation directory; the `current` symlink is switched atomically under
// a lock. Old generations are kept; nothing in --out is ever deleted except a build's own failed staging.
const MARKER = '.graphify-context';
const EXTRACT_ARGS = ['--code-only', '--max-workers', '2'];
const SCHEMA = 2;
const GEN = /^gen-[0-9a-f]{16}$/;
const HEX = /^[0-9a-f]{64}$/;
const LOCK_WAIT_MS = 100;
const LOCK_TRIES = 300;
export const EXIT = { ok: 0, failure: 1, stale: 2, missingTool: 3 };

export class ContextError extends Error {
  constructor(message, code = EXIT.failure) {
    super(message);
    this.code = code;
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const within = (parent, child) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function gitRaw(cwd, args, input) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd, input, maxBuffer: 1 << 30, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });
}
const git = (cwd, args) => gitRaw(cwd, args).toString('utf8').trim();
// Path lists are NUL-delimited and must never be trimmed or re-encoded.
const nulList = (buffer) => buffer.toString('latin1').split('\0').filter((item) => item.length > 0)
  .map((item) => Buffer.from(item, 'latin1').toString('utf8'));

function assertSafeRel(path) {
  const parts = path.split('/');
  if (path.includes('\uFFFD') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new ContextError('repository contains a path that cannot be indexed safely (non-UTF-8 or traversal).');
  }
}

function repoRoot(cwd) {
  return realpathSync(git(cwd, ['rev-parse', '--show-toplevel']));
}

// Canonicalize through the deepest existing ancestor so symlinks and `..` cannot alias the worktree.
function canonical(path) {
  const parts = [];
  let current = resolve(path);
  while (!lstatOrNull(current)) {
    parts.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...parts);
}

function checkOutput(out, root) {
  const real = canonical(out);
  if (within(root, real) || within(real, root)) {
    throw new ContextError('--out must be outside the repository and must not contain it (after resolving symlinks).');
  }
  return real;
}

// True when a regular marker exists; a symlink or other non-regular marker is always refused.
function hasMarker(marker) {
  const stat = lstatOrNull(marker);
  if (stat && !stat.isFile()) throw new ContextError('--out has a non-regular graphify-context marker; refusing to use it.');
  return stat !== null;
}

// `beforeCreate` is a test seam for the first-use initialization race.
export function ensureOutputDir(out, beforeCreate = () => {}) {
  const stat = lstatOrNull(out);
  const marker = join(out, MARKER);
  if (!stat) {
    mkdirSync(out, { recursive: true });
  } else if (!stat.isDirectory()) {
    throw new ContextError('--out exists and is not a directory.');
  }
  if (hasMarker(marker)) return;
  if (readdirSync(out).length > 0 && !hasMarker(marker)) {
    throw new ContextError('--out is not empty and is not a graphify-context directory; refusing to use it.');
  }
  beforeCreate();
  try {
    writeFileSync(marker, 'managed by scripts/graphify-context.mjs\n', { flag: 'wx' });
  } catch (error) {
    // A concurrent initializer may have created it; accept only a regular marker.
    if (error.code !== 'EEXIST' || !hasMarker(marker)) throw error;
  }
}

// Reads a regular file below base without following any symlinked component; null when absent.
function readArtifact(base, ...parts) {
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatOrNull(current);
    if (!stat) return null;
    const last = index === parts.length - 1;
    if (stat.isSymbolicLink() || (last ? !stat.isFile() : !stat.isDirectory())) {
      throw new ContextError(`artifact ${parts.join('/')} is a symlink or not a regular file; refusing to read it.`);
    }
  }
  const fd = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new ContextError('unexpected symlink in snapshot.');
    return entry.isDirectory() ? listFiles(join(dir, entry.name), name) : [name];
  });
}

function fingerprint(entries) {
  const hash = createHash('sha256');
  for (const path of [...entries.keys()].sort()) hash.update(`${path}\0${sha256(entries.get(path))}\n`);
  return hash.digest('hex');
}

function hashTree(dir) {
  const hash = createHash('sha256');
  for (const name of listFiles(dir).sort()) {
    if (name.split('/').includes('__pycache__')) continue;
    hash.update(`${name}\0${sha256(readFileSync(join(dir, name)))}\n`);
  }
  return hash.digest('hex');
}

// ---- trusted tool -------------------------------------------------------------------------

function findExecutable(bin, pathEnv) {
  const candidates = bin.includes(sep) ? [bin]
    : (pathEnv ?? '').split(':').filter((dir) => isAbsolute(dir)).map((dir) => join(dir, bin));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return realpathSync(path);
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new ContextError('graphify is not installed (optional); use direct source search instead of a graph.',
    EXIT.missingTool);
}

function packageIdentity(path) {
  const hash = createHash('sha256').update(readFileSync(path));
  const lib = join(dirname(dirname(path)), 'lib');
  let kind = 'executable-only';
  if (lstatOrNull(lib)) {
    for (const entry of readdirSync(lib).filter((name) => name.startsWith('python')).sort()) {
      const pkg = join(lib, entry, 'site-packages', 'graphify');
      if (lstatOrNull(pkg)?.isDirectory()) {
        hash.update(hashTree(pkg));
        kind = 'package';
      }
    }
  }
  return { identity: hash.digest('hex'), kind };
}

// Runs fn with a trusted extractor and an owned, empty HOME/settings/cache; never the user's.
function withTool({ bin, pathEnv, root }, fn) {
  const path = findExecutable(bin, pathEnv);
  if (within(root, path)) {
    throw new ContextError('graphify resolves inside the repository being indexed; refusing to execute it.');
  }
  const scratch = mkdtempSync(join(tmpdir(), 'graphify-context-'));
  try {
    const dirs = ['home', 'config', 'cache', 'tmp'].map((name) => join(scratch, name));
    dirs.forEach((dir) => mkdirSync(dir));
    const [home, config, cache, tmp] = dirs;
    const env = {
      PATH: `${dirname(path)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache,
      TMPDIR: tmp, GRAPHIFY_NO_AUTO_REFRESH: '1', PYTHONDONTWRITEBYTECODE: '1',
    };
    const version = spawnSync(path, ['--version'], { encoding: 'utf8', env, cwd: scratch, timeout: 30000 });
    if (version.status !== 0) throw new ContextError('graphify --version failed; treat the graph as unavailable.');
    const { identity, kind } = packageIdentity(path);
    return fn({ path, version: version.stdout.trim(), identity, kind, env, scratch });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ---- source collection --------------------------------------------------------------------

function committedKey(root, rev) {
  if (rev.startsWith('-')) throw new ContextError('--rev must be a revision, not an option.');
  const commit = git(root, ['rev-parse', '--verify', `${rev}^{commit}`]);
  return { commit, tree: git(root, ['rev-parse', '--verify', `${commit}^{tree}`]) };
}

// Exact Git tree bytes (no archive attributes); symlinks and submodules are excluded, and counted.
function collectCommitted(root, { commit, tree }) {
  const records = gitRaw(root, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString('latin1').split('\0')
    .filter(Boolean);
  const blobs = [];
  let excluded = 0;
  for (const record of records) {
    const tab = record.indexOf('\t');
    const [mode, type, oid] = record.slice(0, tab).split(' ');
    if (mode === '120000' || type === 'commit') excluded += 1;
    else blobs.push({ oid, path: Buffer.from(record.slice(tab + 1), 'latin1').toString('utf8') });
  }
  const algo = blobs[0]?.oid.length === 64 ? 'sha256' : 'sha1';
  const out = gitRaw(root, ['cat-file', '--batch'], blobs.map(({ oid }) => `${oid}\n`).join(''));
  const entries = new Map();
  let offset = 0;
  for (const { oid, path } of blobs) {
    const eol = out.indexOf('\n', offset);
    const [, , size] = out.subarray(offset, eol).toString('latin1').split(' ');
    const data = out.subarray(eol + 1, eol + 1 + Number(size));
    offset = eol + 1 + Number(size) + 1;
    const actual = createHash(algo).update(`blob ${data.length}\0`).update(data).digest('hex');
    if (actual !== oid) throw new ContextError('snapshot content does not match the Git tree; nothing was published.');
    assertSafeRel(path);
    entries.set(path, data);
  }
  return { entries, excluded, source: tree };
}

function readRegular(root, file) {
  assertSafeRel(file);
  const full = join(root, file);
  const stat = lstatOrNull(full);
  if (!stat || stat.isDirectory()) return { skip: false };
  if (stat.isSymbolicLink()) return { skip: true };
  if (!stat.isFile()) return { skip: false };
  const verify = () => {
    if (realpathSync(full) !== full) throw new ContextError(`indexed path ${file} traverses a symlink; refusing to read outside the worktree.`);
  };
  verify();
  const fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const data = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = readSync(fd, data, read, stat.size - read, read);
      if (n === 0) break;
      read += n;
    }
    verify();
    return { data: data.subarray(0, read) };
  } finally {
    closeSync(fd);
  }
}

function collectWorktree(root) {
  const files = new Set(nulList(gitRaw(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])));
  const entries = new Map();
  let excluded = 0;
  for (const file of files) {
    const result = readRegular(root, file);
    if (result.data) entries.set(file, result.data);
    else if (result.skip) excluded += 1;
  }
  return { entries, excluded, source: fingerprint(entries) };
}

function collect(root, mode, rev) {
  if (mode === 'worktree') {
    const head = committedKey(root, 'HEAD');
    return { ...head, ...collectWorktree(root) };
  }
  const key = committedKey(root, rev);
  return { ...key, ...collectCommitted(root, key) };
}

// ---- freshness ----------------------------------------------------------------------------

function keyFor(root, mode, source, tool) {
  return {
    schema: SCHEMA, mode,
    evidence: mode === 'worktree' ? 'dirty-worktree-not-exact-head' : 'committed-snapshot',
    repoRoot: root, commit: source.commit, source: source.source,
    tool: { version: tool.version, identity: tool.identity, kind: tool.kind },
    extractArgs: EXTRACT_ARGS,
  };
}

function lightSource(root, mode, rev) {
  if (mode === 'worktree') return { ...committedKey(root, 'HEAD'), source: fingerprint(collectWorktree(root).entries) };
  const key = committedKey(root, rev);
  return { ...key, source: key.tree };
}

const KEY_FIELDS = ['schema', 'mode', 'evidence', 'repoRoot', 'commit', 'source', 'tool', 'extractArgs'];

// Graphify node-link format: unique string node ids; links reference existing ids.
export function graphProblem(bytes) {
  let graph;
  try {
    graph = JSON.parse(bytes.toString('utf8'));
  } catch {
    return 'graph output is not valid JSON';
  }
  if (graph === null || typeof graph !== 'object' || Array.isArray(graph)) return 'graph output is not an object';
  const links = graph.links ?? graph.edges;
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) return 'graph output has no nodes array';
  if (!Array.isArray(links)) return 'graph output has no links array';
  const ids = new Set();
  for (const node of graph.nodes) {
    if (node === null || typeof node !== 'object' || typeof node.id !== 'string' || node.id === '') return 'graph has an invalid node';
    if (ids.has(node.id)) return 'graph has duplicate node ids';
    ids.add(node.id);
  }
  for (const link of links) {
    if (link === null || typeof link !== 'object' || !ids.has(link.source) || !ids.has(link.target)) {
      return 'graph has a link with a missing endpoint';
    }
  }
  return null;
}

const GRAPH_PARTS = ['graph', 'graphify-out', 'graph.json'];
const graphPath = (gen) => join(gen, ...GRAPH_PARTS);

function currentGeneration(out) {
  const link = join(out, 'current');
  const stat = lstatOrNull(link);
  if (!stat) return null;
  if (!stat.isSymbolicLink()) return { corrupt: 'current is not a symlink' };
  const name = readlinkSync(link);
  if (!GEN.test(name)) return { corrupt: 'current points outside the generation layout' };
  const dir = join(out, name);
  if (!lstatOrNull(dir)?.isDirectory()) return { corrupt: 'current generation is missing' };
  return { dir };
}

const wellFormed = (p) => p !== null && typeof p === 'object' && HEX.test(p.graphSha256) && HEX.test(p.snapshotSha256)
  && typeof p.builtAt === 'string' && typeof p.tree === 'string' && Number.isInteger(p.excludedSymlinksOrSubmodules);

function inspectWith({ root, out, mode, rev }, tool) {
  const current = currentGeneration(out);
  if (!current) return { status: 'missing', reason: 'no published graph for this output' };
  if (current.corrupt) return { status: 'stale', reason: current.corrupt };
  let provenance;
  try {
    provenance = JSON.parse(readArtifact(current.dir, 'provenance.json') ?? 'null');
  } catch (error) {
    if (error instanceof ContextError) return { status: 'stale', reason: error.message };
    if (!(error instanceof SyntaxError)) throw error;
    return { status: 'stale', reason: 'provenance is missing or corrupt' };
  }
  if (!wellFormed(provenance)) return { status: 'stale', reason: 'provenance is malformed' };
  const want = keyFor(root, mode, lightSource(root, mode, rev), tool);
  const changed = KEY_FIELDS.filter((field) => JSON.stringify(provenance[field]) !== JSON.stringify(want[field]));
  const base = { provenance, want, gen: current.dir };
  if (changed.length > 0) return { status: 'stale', reason: `changed: ${changed.join(', ')}`, ...base };
  let bytes;
  try {
    bytes = readArtifact(current.dir, ...GRAPH_PARTS);
  } catch (error) {
    if (!(error instanceof ContextError)) throw error;
    return { status: 'stale', reason: error.message, ...base };
  }
  if (bytes === null) return { status: 'stale', reason: 'graph output is missing', ...base };
  const problem = sha256(bytes) !== provenance.graphSha256 ? 'graph output changed since it was built' : graphProblem(bytes);
  return problem ? { status: 'stale', reason: problem, ...base } : { status: 'fresh', ...base };
}

function prepare({ cwd, out, bin, pathEnv }) {
  const root = repoRoot(cwd);
  return { root, out: checkOutput(out, root), bin, pathEnv };
}

export function inspect(args) {
  const ctx = { ...prepare(args), mode: args.mode, rev: args.rev };
  return withTool(ctx, (tool) => inspectWith(ctx, tool));
}

// ---- build --------------------------------------------------------------------------------

// No automatic stale-lock recovery: a crashed holder leaves `.lock`, which must be removed by hand.
function withLock(out, tries, fn) {
  const lock = join(out, '.lock');
  const token = randomBytes(16).toString('hex');
  for (let attempt = 0; ; attempt += 1) {
    try {
      mkdirSync(lock);
      writeFileSync(join(lock, 'owner'), token, { flag: 'wx' });
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (attempt >= tries) {
        throw new ContextError('output is busy or has a stale `.lock` from a crashed build; remove it manually if no build is running.');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_WAIT_MS);
    }
  }
  try {
    return fn();
  } finally {
    if (readFileSync(join(lock, 'owner'), 'utf8') === token) rmSync(lock, { recursive: true });
  }
}

function writeSnapshot(dir, entries) {
  for (const [path, data] of entries) {
    const dest = join(dir, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, data, { flag: 'wx' });
  }
  const written = new Map(listFiles(dir).map((name) => [name, readFileSync(join(dir, name))]));
  if (fingerprint(written) !== fingerprint(entries)) {
    throw new ContextError('snapshot on disk differs from the collected source; nothing was published.');
  }
}

function buildWith(ctx, tool) {
  const { root, out, mode, rev } = ctx;
  const before = collect(root, mode, rev);
  const key = keyFor(root, mode, before, tool);
  const name = `gen-${randomBytes(8).toString('hex')}`;
  const gen = join(out, name);
  let published = false;
  mkdirSync(gen);
  try {
    writeSnapshot(join(gen, 'source'), before.entries);
    const result = spawnSync(tool.path, ['extract', join(gen, 'source'), ...EXTRACT_ARGS, '--out', join(gen, 'graph')], {
      encoding: 'utf8', env: tool.env, cwd: tool.scratch, timeout: 600000,
    });
    if (result.error || result.status !== 0) {
      throw new ContextError(`graphify extraction failed (${result.error?.code ?? `exit ${result.status}`}); previous graph kept.`);
    }
    const bytes = readArtifact(gen, ...GRAPH_PARTS);
    if (bytes === null) throw new ContextError('graphify produced no graph.json; previous graph kept.');
    const problem = graphProblem(bytes);
    if (problem) throw new ContextError(`${problem}; previous graph kept.`);

    if (!lstatOrNull(join(gen, 'source'))?.isDirectory()) throw new ContextError('snapshot changed during extraction; previous graph kept.');
    // Observe the generation's actual source after extraction, not the pre-extraction claim.
    const observed = new Map(listFiles(join(gen, 'source')).map((name) => [name, readFileSync(join(gen, 'source', name))]));
    if (fingerprint(observed) !== fingerprint(before.entries)) {
      throw new ContextError('snapshot changed during extraction; previous graph kept.');
    }
    const after = collect(root, mode, rev);
    if (keyFor(root, mode, after, tool).source !== key.source || after.commit !== before.commit) {
      throw new ContextError('source changed during the build; previous graph kept. Rebuild when work is quiet.');
    }
    const provenance = {
      ...key, builtAt: new Date().toISOString(), graphSha256: sha256(bytes),
      snapshotSha256: fingerprint(observed), tree: before.tree, excludedSymlinksOrSubmodules: before.excluded,
    };
    // Exclusive create: an extractor-supplied file or symlink is never overwritten or followed.
    writeFileSync(join(gen, 'provenance.json'), `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
    if (lstatOrNull(join(out, 'current')) && !lstatOrNull(join(out, 'current')).isSymbolicLink()) {
      throw new ContextError('`current` is not a symlink; refusing to replace it.');
    }
    const tmpLink = join(out, `current.${randomBytes(4).toString('hex')}`);
    symlinkSync(name, tmpLink);
    renameSync(tmpLink, join(out, 'current'));
    published = true;
    return { status: 'built', provenance, want: key, gen };
  } finally {
    if (!published) rmSync(gen, { recursive: true, force: true });
  }
}

export function ensure(args, { force = false } = {}) {
  const ctx = { ...prepare(args), mode: args.mode, rev: args.rev };
  if (!force) {
    const first = withTool(ctx, (tool) => inspectWith(ctx, tool));
    if (first.status === 'fresh') return first;
  }
  ensureOutputDir(ctx.out);
  // Re-check under the lock so overlapping callers reuse a generation that just became fresh.
  return withLock(ctx.out, args.lockTries ?? LOCK_TRIES, () => withTool(ctx, (tool) => {
    if (!force) {
      const again = inspectWith(ctx, tool);
      if (again.status === 'fresh') return again;
    }
    return buildWith(ctx, tool);
  }));
}

export const build = (args) => ensure(args, { force: true });

// ---- CLI ----------------------------------------------------------------------------------

export function handoffLine({ status, reason, provenance, want, gen }, task) {
  const key = provenance ?? want;
  const parts = [`graph=${status}${reason ? ` (${reason})` : ''}`];
  if (key) parts.push(`evidence=${key.evidence}`, `commit=${key.commit}`);
  if (gen) parts.push(`graph-json=${graphPath(gen)}`, `provenance=${join(gen, 'provenance.json')}`);
  if (task) parts.unshift(`task=${task}`);
  return parts.join('; ');
}

const usage = () => 'usage: graphify-context.mjs <status|ensure> --out ABS_DIR [--rev REV | --worktree] [--task TEXT]\n'
  + '  default: committed snapshot of REV (exact commit evidence); --worktree: dirty snapshot, never exact-head evidence.\n'
  + '  Run from the checkout to index; invoke the trusted helper by absolute path. GRAPHIFY_BIN overrides discovery.';

function parseArgs(argv, env) {
  const [command, ...rest] = argv;
  const options = { mode: 'committed', rev: 'HEAD', task: '', bin: env.GRAPHIFY_BIN ?? 'graphify', pathEnv: env.PATH };
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
  return { command, options };
}

export function main(argv, cwd = process.cwd(), env = process.env) {
  const { command, options } = parseArgs(argv, env);
  const args = { cwd, ...options };
  const result = command === 'ensure' ? ensure(args) : inspect(args);
  return { code: result.status === 'fresh' || result.status === 'built' ? EXIT.ok : EXIT.stale, line: handoffLine(result, options.task) };
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
