# Storage isolation implementation ledger

Date: October 2, 2026. Scope: foreground SQLite isolation and removal of repeated worker construction from read-only analytics.

## Finding

The Node SQLite adapter already runs each connection in a worker, removing native SQL CPU and lock waits from the sidecar JavaScript event loop. A residual cost remained in `withBackfillDb`: every invocation creates a new SQLite connection/worker, configures it, performs the body, and tears it down. That is appropriate for uncommon write-repair and maintenance jobs but was also used by Usage and Zen read-only aggregations on cache misses.

A production-shaped Node CJS benchmark of `SqliteWorkerClient` measured twenty fresh worker -> ready -> SELECT 1 -> close cycles at **32.08 ms median / 44.62 ms p95**, versus **0.069 ms median** for the same query on an already-open worker. The roughly **463x** difference is connection/worker transport overhead before application query cost.

## Change

`Database.Interface` now exposes `scanDb()`, a lazy persistent query-only analytical connection:

- file-backed databases create no scan worker at Database startup;
- the first caller is serialized through one permit and double-checks the cached handle, so concurrent first scans create one connection;
- `Layer.buildWithScope(..., lifetimeScope)` binds the native layer/finalizer to the Database service lifetime rather than the first request scope;
- `PRAGMA query_only = ON`, short busy timeout and the existing cache/foreign-key settings keep the analytical lane from becoming another writer;
- the lane is distinct from the latency-sensitive persistent `readDb`, so a heavy dashboard aggregation cannot monopolize interactive read admission;
- `:memory:` returns the primary `db` handle and applies no read-only pragma because a second in-memory SQLite handle would be a separate database and query_only would disable the shared writer.

`Usage.summary`, `Usage.modelProfile`, and Zen-free snapshot scans now use `scanDb()` under their existing service-level query permits. Explicit search repairs, backfills, retention and other write/maintenance operations continue to use one-shot maintenance connections; their isolation semantics are unchanged.

## Validation

`packages/core/test/database-reader.test.ts` verifies that a file-backed scan handle is distinct from primary/readDb, survives the short caller scope that first acquired it, is reused by later callers, reads committed state and rejects writes. The in-memory case proves the scan alias remains writable through the primary handle.

Fresh focused results:

```text
packages/core:
  bun test test/database-reader.test.ts
  3 passed, 0 failed

packages/opencode:
  bun test test/usage/usage.test.ts
  7 passed, 0 failed

  bun test test/usage/zen-free.test.ts
  1 passed, 0 failed
```

A Node-targeted ESM proof through the actual worker-backed `Database.layerFromPath` service reported reused=true, isolated=true, queryOnly=1, value=7, writeRejected=true.

Whole-package typechecks are currently red on unrelated concurrently edited source/tests; targeted diagnostics contain no scanDb, Database, Usage or Zen-free error introduced by this change. This ledger therefore claims the focused storage invariant and Node execution proof, not global dirty-worktree typecheck closure.