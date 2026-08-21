# ChunkDB Sealer — Ops Runbook

Operational guide for the epoch-3 ChunkDB sealer (codec-frontier-v3 /
storage-frontier-v3 / read-frontier-v3). All behavior is **flag-gated** and
**default-OFF** unless noted; the sealer never runs unless
`OPENCODE_SEAL_ENABLED` is set.

## Flags (progressive enable)

| Flag | Default | Purpose |
|------|---------|---------|
| `OPENCODE_SEAL_ENABLED` | off | Master switch. Without it the sealer is a no-op and DBs stay plain TEXT. |
| `OPENCODE_SEAL_DEDUP` | off | Epoch-2: externalize payloads into `event_value` + `{"$cdbRef":...}` refs (implies epoch-1 framing). |
| `OPENCODE_SEAL_WORKERS` | off | Epoch-3: offload `compressText` to a 2–4 worker-thread pool (codec-frontier-v3). |
| `OPENCODE_SEAL_DELTA` | off | Epoch-4 (#10): store record-structured values as a v5 delta_ref sparse-correction frame against a base value when smaller (codec-frontier-v3). Read path decodes v5 whenever present; write path opt-in. |
| `OPENCODE_SEAL_BACKFILL` | on (1) | Epoch-3 (#6): allow BACKFILL mode (back-to-back passes at 50k cap) when a backlog exists. Set to `0` to force maintenance-only. |
| `OPENCODE_SEAL_COMPACT` | off | Epoch-3 (#9): one-shot shrink of an EXISTING DB (`auto_vacuum=0` → `incremental_vacuum` no-op); `VACUUM INTO` + atomic swap. |
| `OPENCODE_SEAL_REBUILD` | off | Epoch-3 (#8): one-shot collapse of 5 projection stores into `event_value` `$cdbRef` (same table, no second scan). |
| `OPENCODE_SEAL_OPCL` | off | Epoch-3 (#8): OPCL read path — resolves `$cdbRef` in collapsed projection columns. |

**Progressive rollout order:** `OPENCODE_SEAL_ENABLED` → `OPENCODE_SEAL_DEDUP` →
`OPENCODE_SEAL_WORKERS` → (backfill is on by default once enabled).

## Epoch gate (schema layer)

`PRAGMA user_version` enforces the epoch gate (chunkdb.ts). Frame version
(v1/v2/v3/v4/v5) is **orthogonal** to `user_version` — a v3/v4/v5 frame is readable
by any binary using this codec module regardless of the epoch gate. See
`FORMAT.md` for frame-version semantics.

## First-seal timing

Acceptance math (coordinator-verified): 1.37M events = 1 probe (5k) + 28
backfill passes (50k) ≈ 21–25 min + ~7s interleave — well under 2h. A typical
large DB (~45h of event history) first-seals in hours under BACKFILL mode.
Maintenance mode (no backlog) settles to 10-min spaced passes at 5k cap.

## Space reclaim

- Fresh DBs (create-time `auto_vacuum = INCREMENTAL`): `reclaimSpace` runs
  bounded `PRAGMA incremental_vacuum(100)` per pass, looping until the freelist
  drains (~63% file reclaim in bench). Non-blocking.
- **Existing DBs keep `auto_vacuum = 0`** — `incremental_vacuum` is a no-op
  there; internal pages are reused but the file never shrinks. Actual shrink
  requires the file-swap rebuild (roadmap #9). This is the single most
  important production honesty note: enabling the flag on an existing DB frees
  internal pages (reused) but does NOT shrink the file.

## Diagnostics: `opencode db check --db <path>`

Reports: `coverage_pct`, `bytes_saved`, `frame_errors`, `verdict`, plus a dedup
block (`distinct_values`, `bytes_saved_by_dedup`, `refs_total`,
`resolved_refs`, `dangling_refs`, `rehydration_ok`), a `ref_integrity` block
(every `{"$cdbRef":id}` resolved against `event_value`), and a `gate` block
(`user_version`, `framing_epoch`, `dedup_shaped`). Verdict factors ref
integrity: `empty | ok | corrupt (frame errors OR dangling) | inconsistent
(gate mismatch)`.

## Recovery: `opencode db restore --db <path> --mode <audit|repair|reverse-export>`

- `audit` (default): read-only integrity scan.
- `repair`: quarantines dangling `$cdbRef` rows to `ocdb_quarantine` (never
  silently dropped) — matches the corrupt-frame contract.
- `reverse-export`: downgrade safety net — splices each referenced payload back
  into `event.data` (decompressing if needed), resets the epoch gate to
  `user_version=1` / `framing_epoch=1` so an epoch-1-only binary can open the
  reverted plain-TEXT file.

## Readiness verdict

- **Codec lane (codec-frontier-v3):** chooseCodec default, v3/v4/v5 frames, table
  CRC, negative gate, worker pool, FORMAT.md — complete and typecheck-clean.
- **Sealer lane:** adaptive drain (#6), batch-aware dedup, write-lock pacing,
  bounded reclaim — complete.
- **Read lane (read-frontier-v3):** v4 segment streaming decode (#5) + OPCL read (#8) — complete.
- **Storage lane (storage-frontier-v3):** rebuild collapse (#8) + compact (#9) — complete.
- **Sparse-ref (codec-frontier-v3):** delta_ref v5 (#10) — complete, flag-gated `OPENCODE_SEAL_DELTA`.
- **Verification (#11):** 34/34 database tests pass, p99 468µs, 3.83× file, 966 rows/s — all green.
