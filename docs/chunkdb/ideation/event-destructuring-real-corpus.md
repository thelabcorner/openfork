# Event Payload De-Structuring — REAL-CORPUS CORRECTION (v2)

**Author:** coordinator, swarm `chunkdb-ideation`
**Data:** measured read-only on the 18 GB sanctioned snapshot (`D:\opencode-backup\opencode-db-snapshot-20260812\opencode - Copy.db`, 1,377,243 events) and the live DB copy. **The source files were never modified; all work ran on readonly opens and temp clones.**
**Supersedes:** `event-destructuring.md` where they conflict. This document is the correction.

---

## 0. Honest preamble — my synthetic model was wrong

`event-destructuring.md` claimed a structural encoder + segment table reaches 0.043–0.051 and that "semantic deltas are dead." Those numbers were measured on **synthetic payloads I built from the schemas** — and my synthetic `message.updated` payloads carried `role/model/text`, but the **real** payloads are dominated by `info.summary.diffs` (full git diff patches). I tuned the design against a distribution that does not match the production corpus. The benchmark-arch lane's hard rule — "generate-at-bench-time is a veto; use real distinct-session corpora" — is exactly the discipline I violated, and the real data punishes it.

**The correction is not "structural encoding is useless."** It is: the real corpus has a *different dominant byte class*, and the highest-leverage elimination for that class is **aggregate-level exact-value deduplication**, which my synthetic streams neither contained nor tested.

---

## 1. The real corpus (18 GB snapshot, 1,377,243 events)

### 1.1 Type mix by row count

| versionedType | rows | % rows |
|---|---|---|
| `message.part.updated.1` | 944,702 | 68.6% |
| `message.updated.1` | 333,161 | 24.2% |
| `session.updated.1` | 97,742 | 7.1% |
| `session.created.1` | 1,310 | 0.1% |
| `session.next.*` (V2) | 209 | 0.015% |
| `message.removed.1` | 119 | ~0% |

**V2 `session.next` steers — the class my synthetic streams were dominated by — are essentially nonexistent in this corpus (0.015%).** This is a V1-heavy fork database. My steer-heavy synthetic mix was doubly wrong.

### 1.2 The byte king: `message.updated.1` carries full git diff patches

Sampled real `message.updated.1` payloads by size bucket:

| Raw size | `info.summary` share | dominant field |
|---|---|---|
| 553 B | — | `path`, `tokens`, ids |
| 3,170 B | **95.1%** | `summary.diffs` (git patches) |
| 50,952 B | **99.7%** | `summary.diffs` |
| 548,243 B | **100.0%** | `summary.diffs` |
| max 24 MB (live DB: 6.3 MB) | — | `summary.diffs` |

**`message.updated` payloads are almost entirely `summary.diffs` — full git diff patches** (`{"diffs":[{"file":..., "patch":"Index: ..."}...]}`). This is arbitrary text content, not JSON structure — which is exactly why:
- **structural encoding added only ~2%** on real payloads (the 38%-keys / 32%-IDs census was true of my synthetic stream, not of diff-patch payloads where keys/IDs are a rounding error),
- **elision (sessionID) added ~0.2%** (sessionID appears once per payload, not 100×),
- yet **brotli JSON streams still reached only 0.24–0.26** because the diff patches are large, mostly-unique text.

### 1.3 The real elimination: summary.diffs repeats across message versions

`message.updated` has heavy version multiplicity (a message is republished many times; histogram peaks at v=3 with a long tail to v=236). And every version re-carries the *session's* summary.diffs:

| Session | message.updated events | **distinct summary values** | top multiplicity | elim-inable repeats | stored-once-per-value |
|---|---|---|---|---|---|
| `ses_0361b832…` | 1,713 | **225** | **1,284** | **50%** | 50% (1.24 GB) |
| `ses_01e19df4…` | 689 | **8** | **516** | **98%** | 2% (12.6 MB) |

**The same full diff patch is stored 1,284 times (or 516 times) in one session.** This is *entirely eliminable duplicate data* — the definition of "reconstructable data" the user asked me to hunt. And critically:
- **LZ cannot reach it**: a single value repeats across versions thousands of events apart; even 64 KB segment windows and brotli's own 16 MB max window cannot back-reference version 1 from version 1,284. That's why one-shot brotli on cross-session samples stayed at 0.24.
- **Cross-aggregate LZ doesn't help either** (diffs are session-specific), so only *aggregate-scoped exact-value dedup* captures it.

`message.part.updated` (68.6% of rows, 9.8% of bytes) shows **0% byte-identical-consecutive** — tool parts grow monotonically (streaming text), so no exact dedup there; that class is unique text and stays shared-window-LZ territory.

---

## 2. The revised Pareto (whole-DB, real corpus)

Byte share estimate: `message.updated` is ~85–90% of event-subsystem bytes in this fork (the live DB measured 89.9% of 1.3 GB event bytes; the snapshot's heaviest sessions confirm it). `session.updated` + `part.updated` are the rest.

```
Revised Pareto (event subsystem, vs current raw JSON storage):
  A. Aggregate exact-value dedup of summary.diffs   → 50–98% of message.updated bytes
     (typical session ~50%; extreme ~98%; whole-DB blend likely 40–70% of ALL event bytes)
  B. Shared-window LZ frames (OSES segments)         → captures part.updated text + what
                                                      remains of message.updated after dedup
  C. Structural encoding + elision                    → ~2–3% on this corpus (diff-dominated)
  D. Semantic deltas (checkpoint+patch)               → dead (measured ~= full-state post-LZ)
```

**The single highest-leverage move is not a codec tweak — it is aggregate-level exact-value deduplication of the repeated `summary.diffs` payload.** Everything else (structural encoding, elision, dictionaries) is a rounding error against it on this corpus.

---

## 3. The design: aggregate value table (content-addressed, per-aggregate)

```sql
-- Per-aggregate large-value store. Exact bytes; content-addressed within aggregate.
CREATE TABLE IF NOT EXISTS event_value (
  aggregate_id  TEXT NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE,
  value_id      INTEGER NOT NULL,            -- ordinal within aggregate
  sha256        BLOB NOT NULL,               -- dedup key (exact-bytes identity)
  raw_len       INTEGER NOT NULL,
  bytes         BLOB NOT NULL,               -- the JSON-serialized repeated value
  refs          INTEGER NOT NULL DEFAULT 1,  -- refcount for GC on hard delete (cascade covers it)
  PRIMARY KEY (aggregate_id, value_id),
  UNIQUE (aggregate_id, sha256)
);
```

- **What gets a value:** a JSON sub-value (e.g. `info.summary`) whose serialized bytes exceed a threshold (e.g. ≥1 KiB) **and** recur ≥2× in the aggregate. The sealer/backfill scans the aggregate's payloads, hashes candidate sub-values, and promotes repeats to the table.
- **What replaces it in the frame:** a compact `value-ref` (aggregate_id implicit, value_id uvarint) + a *required exactness guard*: on encode, the re-serialized sub-value must hash to the stored sha256; on decode, rehydrate from `event_value` and deep-equal against the schema-encoded value. Any mismatch = fail-closed (never synthesize). This preserves `isDeepStrictEqual(stored.data, encoded)` replay semantics exactly.
- **Scope:** per-aggregate (not global) so session hard-delete cascades cleanly and diff patches (session-specific) don't collide. A global content-addressed store is a later, measured decision — the duplicate-rate evidence here is per-aggregate.
- **Relation to the research doc:** §19.5 deferred large-object dedup "until exact-duplicate rates are measured." This document is that measurement: **the gate is met**. It also resolves §1.2's "content-addressed storage only above an evidence-based size threshold" — the evidence exists and the threshold is real (~1 KiB + ≥2 recurrences).
- **Not the file-backed `Storage` service:** this stays inside SQLite, in the same transactional/backup domain as the events (research doc §20.17 / §F.15 constraints respected — no pointer-to-external-object in the event format; the value table is transactional with the aggregate).

**Whole-DB effect:** if `message.updated` is ~85–90% of event bytes and dedup kills 40–70% of *that*, the event subsystem shrinks by roughly **35–65% before any compression** — and the remaining unique bytes then compress via shared-window frames. Combined with OSES row/index amortization, this is the dominant storage story for this corpus.

---

## 4. What survives from `event-destructuring.md` (and what doesn't)

| Claim (v1) | Verdict after real corpus |
|---|---|
| "Elision is a 25–30% win at frame geometry" | **Correct in general, negligible on THIS corpus** (sessionID once/payload vs 100×/session in synthetic). Keep `sessionID` elision (free, provable) but stop marketing it as the big win here. |
| "Segment table decouples compression from LZ window" | **Still true** for the steer/snapshot classes; but those are ~7% of this corpus. The *aggregate value table* is the real cross-frame dedup mechanism, and it works at any frame size. |
| "Semantic deltas are dead" | **Confirmed** — but for the wrong reason. Deltas are dead because *exact-value dedup* (this doc) and *shared-window LZ* (OSES) both beat them, not because structural encoding did. |
| "Structural encoding is the main event (50–60%)" | **Retracted for this corpus** (~2%). It remains relevant only for schema-rich, text-light classes (V2 steers, session.updated) — which this fork's history barely contains. |
| "Dictionary subsumed by field ordinals" | **Retracted.** On diff-dominated payloads the ordinals don't exist to help. The structural-deflate-dictionary hook stays reserved but is not a v1 target. |

**The methodological lesson (for the record):** I trusted a synthetic corpus built from schemas instead of the real database that was sitting in `D:\` all along. The benchmark-arch lane's corpus-first discipline is not bureaucracy — it is what prevents exactly this kind of wrong-direction optimization.

---

## 5. The three risks, revisited honestly

1. **Field-ordinal stability across `versionedType` evolution** — *de-prioritized*: since structural encoding is ~2% on this corpus, ordinals are not a v1 risk. If/when structural encoding ships for V2 steer classes, the `versionedType` string (`"${type}.${version}"`, verified in `packages/schema/src/event.ts`) already encodes version; ordinals freeze per (versionedType, physicalFormat) and are append-only. Risk remains manageable but deferred.

2. **Real steer/snapshot/tool mix for whole-DB numbers** — *answered*: this corpus is part.updated (68.6% rows) + message.updated (24.2% rows, ~85–90% bytes) + session.updated (7.1%). The steering is nearly all V1. **The mix answer changes the design** (aggregate dedup > structural encoding).

3. **Decode throughput (structural decode + rehydrate vs JSON.parse, ≤5% p99 gates)** — *re-scoped*: the surviving mechanisms are (a) value-dedup rehydrate (a hash-map lookup + table read, cheaper than decompression) and (b) shared-window frame decode (brotli + JSON.parse, same as baseline). Structural decode is no longer on the critical path for this corpus. The gate still applies to the dedup rehydrate path and must be measured on the packaged Electron runtime.

---

## 6. Actionable next steps (measured on real data before any more design)

1. **Size the dedup win on the real DB with a proper aggregate scan** (not just the two heaviest sessions): sum per-aggregate distinct-value bytes vs total for `message.updated`, `session.updated`, `part.updated` on a bounded aggregate sample. Get the true whole-DB elimination fraction.
2. **Probe value-recurrence thresholds**: at what serialized size / recurrence count does the value table pay for itself (table overhead vs saved repeats) per aggregate class?
3. **Confirm `summary.diffs` is the only such field** (scan for other repeated large sub-values: `info.metadata`, `tool.input`, `result`).
4. Then decide: **aggregate value table in OSES v1** (recommended — it is the real Pareto move for this corpus), with structural encoding deferred to a V2-steer-class feature.

---

## 7. Bottom line

The best compression is entire elimination of reconstructable data — and the real corpus's reconstructable data is not JSON keys or sessionIDs, it is the **same full diff patch stored hundreds of times per session**. Aggregate-level exact-value dedup of `summary.diffs` eliminates **50–98% of the byte king** (`message.updated`), a ~35–65% event-subsystem reduction *before compression*, dwarfing every codec tweak in the previous doc. The fork's 2.5 GB raw aggregate exists because each of 1,284+ message versions re-stored the same diff; the whole "de-structure the event codec" campaign was aimed at the wrong byte class. **Aim at the duplicate.**
