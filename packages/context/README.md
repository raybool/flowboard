# FlowBoard shared context

Local, offline project memory for Codex and its subagents. The workspace package
uses Node.js 24's SQLite driver, SQLite FTS5, and a stdio MCP server. All agents
in a local checkout use the same ignored database at
`.flowboard-context/context.sqlite`.
There is no external LLM, embedding service, or required network connection.

## Setup

From the repository root, use Node.js 24 and pnpm 12:

```sh
pnpm install --frozen-lockfile
pnpm context:build
pnpm context:index
pnpm context:status
pnpm context search "auth"
```

The project `.codex/config.toml` registers the `flowboard_context` stdio MCP
server. Restart Codex after building or changing that configuration, and check
it with `codex mcp get flowboard_context`. In a trusted project, Codex can then
discover `context.search`, `context.get`, `context.save`, `context.update`,
`context.get_task`, `context.update_task_context`, and `context.invalidate`. The
MCP command performs a lightweight `update` before serving, so Codex sees
current records without a full scan. Run `pnpm context:update` when the
worktree changes, or `pnpm context:index` to initialize or rebuild the complete
index. The CLI and the MCP server share the same DB.

Manual records can be typed as `architecture`, `api_contract`, `module`,
`decision`, `task`, `fact`, or `assumption`. An MCP save or update is only a
proposal. The CLI confirmation checks that the cited source still has the
same hash, and a replacement keeps the previous version as invalidated history.

`pnpm context reset` rebuilds only derived repository data; manually entered
decisions and task notes survive. Use `pnpm context confirm <id>` for an
important manually entered fact only after checking its source. MCP writes
remain proposed until that explicit review. Invalidating a record hides it
from ordinary search without deleting its history.

Task handoff state is kept separately as one current snapshot per `task_id`.
Use `context.search` for ordinary knowledge retrieval; use `context.get_task`
only when the previous handoff for a known task is needed. Update the snapshot
only after a substantial change or before handing work to another agent.
`context.update_task_context` updates the fields `objective`, `affected_files`,
`architecture_decisions`, `constraints`, `completed_work`, `verification_results`,
`open_issues`, and `source_references`. Omitted fields remain unchanged; supplied
arrays replace their previous values. `context.get_task` returns the snapshot as
`taskContext` alongside task records. Each update raises `revision`, except for
an identical update, which is a no-op. Pass `expected_revision` to detect a
stale handoff and receive a revision conflict error. Task IDs are limited to
160 characters, path references to 240 characters, and substantive handoff
values to 1,200 characters; the complete snapshot is limited to 12,000 UTF-8
bytes. Private reasoning, secrets, and full logs are rejected. These storage
limits are independent from the stricter MCP response token budget, so retrieval
remains bounded without shortening stored handoff data.

Every MCP read and `context.update_task_context` call writes an audit row with
duration, request/response byte counts, success, and (for task updates) revisions
before and after. Audit rows contain metrics only, never the handoff contents.

## Operating model

- Repository indexing stores paths, hashes, compact symbols/structure, and
  import relationships, not complete source files. Search results include
  source paths, the repository HEAD at capture time (even for untracked files),
  timestamps, and fact/assumption status.
- FTS5 supports text search. Git diffs, staged/unstaged changes, and non-ignored
  untracked paths select incremental candidates; only those files are read and
  parsed. Current file hashes are checked against stored snapshots to identify
  outdated records, and Git HEAD is recorded; changes should be refreshed with
  `pnpm context:update`. MCP reads check only their
  candidate records and do not write the database; CLI `status` checks all
  active sources and persists stale flags.
- SQLite WAL and a busy timeout allow independent agent processes to read the
  shared database while writes are serialized. The database remains local and
  ignored by Git; it persists across Codex sessions in the same checkout.
- `.env*`, credentials, keys, generated output, dependencies, and symlinks are
  excluded from indexing. Do not put secrets or personal data into manually
  submitted summaries either. Records are short summaries, not source copies.

MCP retrieval is bounded by default: search returns at most 5 records, selective
reads return at most 3 records per call, and the target response budget is 2,000
tokens. These defaults can be configured without changing the MCP contract:
`FLOWBOARD_CONTEXT_SEARCH_LIMIT`, `FLOWBOARD_CONTEXT_READ_LIMIT`, and
`FLOWBOARD_CONTEXT_RETRIEVAL_TOKEN_BUDGET`. Hard ceilings remain in place at 50,
10, and 16,000 respectively. The server estimates tokens conservatively as
UTF-8 response bytes divided by 3; this is a size guard, not an exact tokenizer.
When a result is bounded, the response includes `truncated`, `returnedCount`,
`omittedCount`, `hasMore`, and `truncationReason`.

You may point tests at a separate Git checkout with `FLOWBOARD_CONTEXT_ROOT`
and a separate database using `FLOWBOARD_CONTEXT_DB`. Do not commit a database
or its `-wal`/`-shm` files.
Back it up only as sensitive local project metadata. The records have stable
IDs, source references, and timestamps so a later HTTP sync adapter can be
added without changing the MCP contract; no sync or remote access is enabled
in this MVP.

## Verification

```sh
pnpm --filter @flowboard/context test
pnpm context status
codex mcp get flowboard_context
```

If MCP tools are missing, verify that the package has been built, that Codex
trusts this checkout and has restarted, and that Node.js 24 and pnpm are on
its PATH. A stale result is a prompt to inspect the cited source, not a fact
to silently trust.
