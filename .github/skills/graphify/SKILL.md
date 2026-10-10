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

`scripts/graphify-context.mjs` automates the steps above on demand (no watcher or hook):

```sh
node scripts/graphify-context.mjs ensure --out ABS_ARTIFACT_DIR [--rev REV | --worktree] [--task TEXT]
node scripts/graphify-context.mjs status --out ABS_ARTIFACT_DIR [--rev REV | --worktree]
```

- `--out` must be an absolute session-artifact directory outside the worktree.
- Default is a snapshot of a committed revision (exact-commit evidence). `--worktree`
  snapshots uncommitted files (edits, additions, deletions), is labelled
  `dirty-worktree-not-exact-head` and is only for a writer's own navigation.
- `ensure` reuses the graph only if commit/source fingerprint, graphify version and
  extraction settings still match and `graph.json` is intact; otherwise it rebuilds.
  Source changes during a build, extraction failure or a missing/corrupt graph publish
  nothing. `status` never builds (exit 2 when missing/stale; exit 3 when graphify is
  not installed, so use direct source search).
- It prints one handoff line: task, graph state, evidence label, commit, and graph and
  provenance paths. Send that line, not graph content.
- Reviewers: run the trusted helper from the coordinator's/main checkout against the
  PR checkout with `--rev <exact head>` into a fresh directory. Never run the candidate
  PR's copy of the helper or skill as trusted. Never reuse the writer's graph.

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
