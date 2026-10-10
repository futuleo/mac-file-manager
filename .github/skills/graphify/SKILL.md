---
name: graphify
description: "Use for local code-graph indexing or broad architecture and relationship questions where a Graphify graph can avoid many source reads. Local AST only; not required for simple lookups, exact diff review, or routine edits."
---

# Graphify: local code navigation

This is a compact, local-only Copilot adapter for the official `graphifyy`
package (tested with version 0.9.84; installation is optional and never required
for builds, tests or reviews). The command is `graphify`. If it is missing, use
direct source search instead of installing it.

## Boundaries

- Repository instructions, user pauses, privacy rules, and independent-review
  requirements take precedence. Loading this skill does not resume paused work.
- Use only local code extraction and local graph queries. Never use semantic
  extraction, LLM community labels, hosted services, cloud/database exports,
  credential discovery, remote cloning, or document/media processing.
- Do not install hooks, watchers, always-on graph-first rules, MCP servers, or
  packages automatically. Do not overwrite repository instructions.
- Prefix every invocation with `GRAPHIFY_NO_AUTO_REFRESH=1` so the package cannot
  replace this adapter with its broader upstream skill.
- The graph is a navigation aid, not authoritative evidence. AST extraction can
  omit code and misresolve relationships, including frontend/native IPC links.
  Read the relevant source before making claims or changes.

## Select a graph

Use a graph only if its source root and revision match the assigned checkout or
exact reviewed snapshot. Record the source commit, dirty-state limitations,
package version, extraction command, and output path alongside each graph.
Never treat a main-branch graph as evidence for an unmerged PR.

If indexing is authorized, preserve the checkout and store output in a session
artifact directory outside version control. Use explicit `--out` and `--graph`
paths; do not change `.gitignore` or commit generated graphs. For a clean
historical revision, index a `git archive` snapshot instead of switching branches.
Rebuild after relevant changes; a commit hash alone does not cover dirty edits.
Do not rebuild merely because this skill was loaded.

## Freshness helper

`scripts/graphify-context.mjs` automates the steps above on demand (no watcher or hook).
It indexes the repository of its **current working directory**, so run it from the checkout
to index, and invoke the helper by absolute path:

```sh
cd ASSIGNED_CHECKOUT && node ABS_HELPER_PATH ensure --out ABS_ARTIFACT_DIR [--rev REV | --worktree] [--task TEXT]
cd ASSIGNED_CHECKOUT && node ABS_HELPER_PATH status --out ABS_ARTIFACT_DIR [--rev REV | --worktree]
```

- `--out` is an absolute directory outside the worktree (symlinks resolved; it may not
  contain the repository). It must be new, empty, or previously created by the helper
  (regular-file marker). The helper never deletes anything in it except its own failed
  staging; old `gen-*` generations are retained, so remove them manually when done.
  A crashed build leaves `.lock`; callers fail with a "busy or stale lock" error and the
  lock must be removed by hand (no automatic reclaim).
- Default is a snapshot of the committed `REV` built from exact Git tree blobs (ignoring
  `export-ignore`), verified against the tree; symlinks and submodules are excluded and
  counted in provenance. `--worktree` snapshots files from disk (edits, additions,
  deletions), rejects symlinked parent directories, is labelled
  `dirty-worktree-not-exact-head` and is only for a writer's own navigation.
- `ensure` reuses the graph only while commit/tree (or worktree fingerprint), graphify
  version, executable/package bytes and extraction settings match and `graph.json` is
  structurally valid; otherwise it rebuilds. Each build is staged in its own generation and
  published atomically under a lock; any failure, mid-build source change or snapshot
  modification during extraction keeps the previous generation. Missing or malformed
  `current`/provenance is reported stale and rebuilt by `ensure`. `status` never builds (exit 2 missing/stale; exit 3 graphify not
  installed, so use direct source search).
- graphify is executed only if it resolves outside the indexed repository, with an empty
  owned HOME/config/cache and a bounded PATH; indexed source is never executed.
- It prints one handoff line (task, graph state, evidence label, commit, graph and
  provenance paths). Graph fields supplement, and never replace, the mandatory PR URL,
  exact SHAs, checks and native-acceptance limitations in a report.
- Reviewers: `cd` into the assigned PR worktree and run the trusted helper by absolute
  path (the main/coordinator checkout's copy, never the PR's) with `--rev <exact head>` and
  a fresh `--out`. Do not reuse the writer's graph.

## Local commands

Replace uppercase path placeholders with resolved, explicitly chosen paths.

```sh
GRAPHIFY_NO_AUTO_REFRESH=1 graphify extract SOURCE --code-only --max-workers 2 --out OUTPUT
GRAPHIFY_NO_AUTO_REFRESH=1 graphify query "specific symbol or relationship" --budget 700 --graph OUTPUT/graphify-out/graph.json
GRAPHIFY_NO_AUTO_REFRESH=1 graphify explain "symbol" --graph OUTPUT/graphify-out/graph.json
GRAPHIFY_NO_AUTO_REFRESH=1 graphify path "source symbol" "target symbol" --graph OUTPUT/graphify-out/graph.json
```

Start with one narrow query. If it is truncated or ambiguous, narrow the symbol
or context before raising the budget. Use direct source search if the graph
does not help; do not repeatedly query it or dump a whole report.

The token budget bounds graph output approximately, not total model billing.
Do not promise credit savings without a measured comparison against targeted
source reads. Reviews still require exact head/base source, applicable checks,
and separate writer/reviewer sessions.
