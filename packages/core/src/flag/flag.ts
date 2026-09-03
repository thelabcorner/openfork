import { Config } from "effect"

export function truthy(key: string) {
  const value = process.env[key]?.toLowerCase()
  return value === "true" || value === "1"
}

const copy = process.env["OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"]
const fff = process.env["OPENCODE_DISABLE_FFF"]

function enabledByExperimental(key: string) {
  return process.env[key] === undefined ? truthy("OPENCODE_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  OPENCODE_AUTO_HEAP_SNAPSHOT: truthy("OPENCODE_AUTO_HEAP_SNAPSHOT"),
  OPENCODE_GIT_BASH_PATH: process.env["OPENCODE_GIT_BASH_PATH"],
  OPENCODE_CONFIG: process.env["OPENCODE_CONFIG"],
  OPENCODE_CONFIG_CONTENT: process.env["OPENCODE_CONFIG_CONTENT"],
  OPENCODE_DISABLE_AUTOUPDATE: truthy("OPENCODE_DISABLE_AUTOUPDATE"),
  OPENCODE_ALWAYS_NOTIFY_UPDATE: truthy("OPENCODE_ALWAYS_NOTIFY_UPDATE"),
  OPENCODE_DISABLE_PRUNE: truthy("OPENCODE_DISABLE_PRUNE"),
  OPENCODE_DISABLE_TERMINAL_TITLE: truthy("OPENCODE_DISABLE_TERMINAL_TITLE"),
  OPENCODE_SHOW_TTFD: truthy("OPENCODE_SHOW_TTFD"),
  OPENCODE_DISABLE_AUTOCOMPACT: truthy("OPENCODE_DISABLE_AUTOCOMPACT"),
  OPENCODE_DISABLE_MODELS_FETCH: truthy("OPENCODE_DISABLE_MODELS_FETCH"),
  OPENCODE_DISABLE_MOUSE: truthy("OPENCODE_DISABLE_MOUSE"),
  // Persistent experiential memory. Getter so the read path can be toggled at
  // runtime (tests / CLI) without a process restart.
  get OPENCODE_DISABLE_MEMORY() {
    return truthy("OPENCODE_DISABLE_MEMORY")
  },
  // Evaluated at access time (not module load) so tests, the CLI, and external
  // tooling can toggle sealing at runtime.
  get OPENCODE_SEAL_ENABLED() {
    return truthy("OPENCODE_SEAL_ENABLED")
  },
  // Epoch-2 ChunkDB reference/dedup table. Implies epoch-1 (OPENCODE_SEAL_ENABLED);
  // an epoch-1-only binary must refuse a DB opened under this flag (see chunkdb.ts
  // epoch gate, user_version=2 fail-closed). Getter so the read path can be
  // exercised under test without a process restart.
  get OPENCODE_SEAL_DEDUP() {
    return truthy("OPENCODE_SEAL_DEDUP")
  },
  // Epoch-3: offload `compressText` to a worker-thread pool so the sealer's
  // main thread stays free for sha256 + SQL while workers compress in parallel.
  // Getter so it can be toggled at runtime (tests / CLI). When off, the sealer
  // uses the proven synchronous `compressText` path.
  get OPENCODE_SEAL_WORKERS() {
    return truthy("OPENCODE_SEAL_WORKERS")
  },
  // Epoch-3 (#6): allow the sealer to run in BACKFILL mode (back-to-back passes
  // at a raised per-pass cap) while a backlog exists, so a large existing DB
  // first-seals in hours instead of days. Default ON (automatic); set to 0 to
  // force maintenance-only cadence (10-min spaced passes at the small cap).
  get OPENCODE_SEAL_BACKFILL() {
    const value = process.env["OPENCODE_SEAL_BACKFILL"]?.toLowerCase()
    return value !== "0" && value !== "false"
  },
  // Epoch-3 (Phase-2, #9): opt-in, flag-gated (default OFF) one-shot shrink of an
  // EXISTING database (auto_vacuum=0 -> incremental_vacuum is a no-op, so the
  // file never shrinks on its own). Runs a dedicated-connection VACUUM INTO into a
  // temp file, verifies it (integrity + migrations + epoch gate + byte-exact
  // rehydration), then atomically swaps (original kept as .bak until verified).
  // Never automatic. Coordinated with the OPENCODE_SEAL_* family naming.
  get OPENCODE_SEAL_COMPACT() {
    return truthy("OPENCODE_SEAL_COMPACT")
  },
  // Epoch-3 (Phase-2, #8): opt-in, flag-gated (default OFF) one-shot REBUILD that
  // extends the #9 file-swap machinery to collapse projections into reference-
  // indexes to event_value (same table, no second scan). Collapses the 4x
  // redundant stores (session_message.data / message.data / session.summary_diffs /
  // event message.updated+session.updated) into event_value $cdbRefs; everything
  // else stays inline-or-frame per R3/R4/R5. Collapse-at-seal-time (R2, no
  // write-time refs), abort-hard fail-closed (Q1), session.summary_diffs as
  // reference-index (Q4). Shares the #9 swap (raw SQLite + GC + copy fallback).
  get OPENCODE_SEAL_REBUILD() {
    return truthy("OPENCODE_SEAL_REBUILD")
  },
  // Epoch-3 (#8 OPCL read path): when ON, the read side resolves `$cdbRef`
  // references in the collapsed projection columns (session_message.data,
  // message.data, session.summary_diffs) back to their canonical payloads in
  // event_value. Default OFF — the write side (OPENCODE_SEAL_REBUILD) is what
  // actually injects the refs; with this OFF the read path is a pure pass-through
  // and never touches event_value for those columns. event.data refs remain
  // gated on OPENCODE_SEAL_DEDUP (epoch-2), handled by rehydrateEvents.
  get OPENCODE_OPCL() {
    return truthy("OPENCODE_OPCL")
  },
  // Epoch-4 (#10): opt-in, flag-gated (default OFF) delta_ref framing on the
  // sealer write path. When ON, the sealer stores record-structured values
  // (e.g. info.summary.diffs across turns) as a sparse correction against a
  // previously-promoted base value in event_value instead of a full frame, when
  // the correction is materially smaller. The read path (resolveCdbRef) decodes
  // v5 delta_ref frames fail-closed (missing base -> quarantine). Default OFF —
  // the v5 frame format is backward-compatible (old binaries fail-closed on
  // version 5) but the write path stays opt-in until the ANVIL Exp E target is
  // confirmed in production-shaped benches.
  get OPENCODE_SEAL_DELTA() {
    return truthy("OPENCODE_SEAL_DELTA")
  },
  // Epoch-2 ChunkDB reference/dedup table. Implies epoch-1 (OPENCODE_SEAL_ENABLED);
  // an epoch-1-only binary must refuse a DB opened under this flag (see chunkdb.ts
  // epoch gate, user_version=2 fail-closed).
  OPENCODE_FAKE_VCS: process.env["OPENCODE_FAKE_VCS"],
  OPENCODE_SERVER_PASSWORD: process.env["OPENCODE_SERVER_PASSWORD"],
  OPENCODE_SERVER_USERNAME: process.env["OPENCODE_SERVER_USERNAME"],
  // Realtime mention-search index (chunked front-coded store). Default ON on
  // ALL platforms including win32: bun:sqlite WAL + node:zlib zstd are the
  // same primitives the main database already uses on Windows, and the index
  // is a rebuildable cache (worst case it reseeds from disk). Getter so tests
  // can toggle at runtime.
  get OPENCODE_SEARCH_INDEX() {
    return process.env["OPENCODE_SEARCH_INDEX"] === undefined ? true : truthy("OPENCODE_SEARCH_INDEX")
  },
  OPENCODE_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("OPENCODE_DISABLE_FFF"),

  // Experimental
  OPENCODE_EXPERIMENTAL_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_FILEWATCHER").pipe(
    Config.withDefault(true),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER: Config.boolean("OPENCODE_EXPERIMENTAL_DISABLE_FILEWATCHER").pipe(
    Config.withDefault(false),
  ),
  OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("OPENCODE_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  OPENCODE_MODELS_URL: process.env["OPENCODE_MODELS_URL"],
  OPENCODE_MODELS_PATH: process.env["OPENCODE_MODELS_PATH"],
  OPENCODE_DB: process.env["OPENCODE_DB"],

  OPENCODE_WORKSPACE_ID: process.env["OPENCODE_WORKSPACE_ID"],
  OPENCODE_EXPERIMENTAL_WORKSPACES: enabledByExperimental("OPENCODE_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get OPENCODE_DISABLE_PROJECT_CONFIG() {
    return truthy("OPENCODE_DISABLE_PROJECT_CONFIG")
  },
  get OPENCODE_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("OPENCODE_EXPERIMENTAL_REFERENCES")
  },
  get OPENCODE_TUI_CONFIG() {
    return process.env["OPENCODE_TUI_CONFIG"]
  },
  get OPENCODE_CONFIG_DIR() {
    return process.env["OPENCODE_CONFIG_DIR"]
  },
  get OPENCODE_PURE() {
    return truthy("OPENCODE_PURE")
  },
  get OPENCODE_PERMISSION() {
    return process.env["OPENCODE_PERMISSION"]
  },
  get OPENCODE_PLUGIN_META_FILE() {
    return process.env["OPENCODE_PLUGIN_META_FILE"]
  },
  get OPENCODE_CLIENT() {
    return process.env["OPENCODE_CLIENT"] ?? "cli"
  },
}
