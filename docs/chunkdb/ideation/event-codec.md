# Event Payload Codec — adversarial analysis + measured design

**Author:** coordinator, swarm `chunkdb-ideation` (follow-on to `adversarial-fork-prototype.md`)
**Method:** reads of the real event schemas (`packages/schema/src/session-event.ts`, `v1/session.ts`, `llm.ts`, `session-message.ts`) + fresh codec probes run under Bun on realistic payloads built to those schemas.
**Status:** analysis + measured design proposal. No code changed.

The question this document answers: **the durable event payloads are simultaneously the best and the worst compression candidate in OpenCode — why, and what does the codec have to do about it?**

---

## 1. The three event payload classes (from the real schemas, not the reference DB)

The fork's codec (`brotli q1`, threshold 4096 code units, per-row framing) treats **every** event identically. The real event set is three classes with opposite properties:

| Class | Example types | Typical size | Share of **rows** | Share of **bytes** | Compressibility under per-row framing |
|---|---|---|---|---|---|
| **C1 tiny steers** | `session.next.agent.switched`, `text.started`, `tool.called`, `prompted`, `step.started`, `shell.started`… | ~50–200 B | **dominant** (~80–90% of the 1.37M rows) | small | **~0** — per-row brotli cannot beat the 14 B header + 24 B gain guard on a 159 B row |
| **C2 full-state snapshots** | `session.updated.1`, `message.updated.1`, `part.updated.1` | ~400–800 B | moderate | significant | poor — the 1-field-delta redundancy across consecutive snapshots is discarded per row |
| **C3 tool tail** | `part.updated.1` tool parts, `tool.success/failed`, `reasoning.ended`, `text.ended`, `shell.ended` | KB–MB (max 32.8 MB) | few | **dominant** (the 2.5 GB aggregate) | **good** — this is the only class per-row framing works on |

**The core problem:** the fork's sealer captures ~4% of the achievable win on a realistic mix, because it only helps C3 while doing literally nothing for C1 (the 80–90% of rows) and C2.

---

## 2. Measured results (Bun, node:zlib, payloads built to the real schemas)

### 2.1 Per-row framing vs shared-window segments — the 23× gap

Realistic mixed segment: **200 steers + 40 `session.updated` snapshots + 4 tool events** (2 with 64 KiB text), raw 192.4 KB, avg 159 B/steer:

| Representation | Stored | Ratio vs raw |
|---|---|---|
| **Fork per-row, threshold 4096, brotli q1** | 59.1 KB | **0.307** (only the 2 big tool rows framed; **all 240 steer/snapshot rows stayed raw TEXT — zero events framed**) |
| Shared-window segment, brotli q1 (one stream) | 2.4 KB | **0.013** |
| Shared-window segment, zstd l1 | 2.3 KB | 0.012 |

**The fork's own sealer captures ~4% of the win (0.307 → the 0.013 achievable), and that 4% is entirely the tool tail.** The count-dominant class — the 200 steers — is left 100% uncompressed because per-row brotli at 4096 frames **zero** of them, and even at threshold 128 it frames zero (a 159 B row saves ~30 B under brotli, which is less than the 14+24 B framing cost — structurally impossible, not a tuning issue).

### 2.2 Class-by-class (200 steers / 40 snapshots / 4 tool events)

| Class | raw | per-row 4096 brotli1 | per-row 128 brotli1 | per-row 128 deflate+dict | **segment brotli1** | **segment brotli4** | segment zstd1 |
|---|---|---|---|---|---|---|---|
| C1 steers | 31.1 KB | **1.000** (0 framed) | 1.000 (0 framed) | 0.856 (100/200) | **0.071** | **0.035** | 0.038 |
| C2 snapshots | 26.4 KB | **1.000** (0 framed) | 0.684 | 0.554 | **0.030** | **0.024** | 0.026 |
| C3 tool tail | 134.9 KB | **0.012** (2 framed) | 0.009 | 0.014 | 0.003 | 0.003 | 0.014* |

*note: zstd l1 is anomalously worse on the concatenated tool stream than brotli — zstd's default window/lazy strategy on a 64 KiB repetitive block; brotli wins here.

### 2.3 Window-size sensitivity (1000 steers, 144 KB raw) — the geometry answer

| Window (raw) | Frames | Framed ratio | vs one-shot |
|---|---|---|---|
| 2 KiB | 72 | 0.193 | 5.4× worse |
| 4 KiB | 36 | 0.136 | 3.8× |
| 8 KiB | 18 | 0.105 | 2.9× |
| 16 KiB | 9 | 0.087 | 2.4× |
| **32 KiB** | 5 | **0.047** | 1.3× |
| 64 KiB | 3 | 0.044 | 1.2× |
| one-shot (whole stream) | 1 | 0.036 | 1.0× |
| per-row | 1000 | 0.976 | 27× |

### 2.4 Elision and structural dictionary — the surprise

| Class | segment brotli1 | segment + SID elision | segment deflate | segment deflate+dict |
|---|---|---|---|---|
| C1 steers | 0.071 | 0.084 (worse!) | 0.058 | 0.057 (≈ no gain) |
| C2 snapshots | 0.030 | 0.031 | 0.030 | 0.028 (≈ no gain) |
| mixed | 0.013 | 0.013 | 0.022 | 0.022 |

**Once a shared window exists, semantic elision and a structural dictionary add ~nothing** — the LZ window already collapses the repeated 30 B `sessionID`, JSON keys, and field names across the events in the frame. Elision only matters for the *first frame of an aggregate's cold history* and for *per-row* framing (both have no window). The swarm's "elide sessionID now" decision holds, but its *value is a cold-start/first-frame optimization*, not the main lever. Same for the structural dictionary: the shared window subsumes it. This de-prioritizes both relative to the OSES §5/§codec expectations.

---

## 3. What this means for the event codec

### 3.1 The events are the best AND worst candidate — now quantified

- **Worst for the fork's per-row codec:** C1 steers at **0.976–1.000** (no framing possible at any threshold; a 159 B row can't beat its own framing overhead), and C2 snapshots at 1.000 under the real 4096 threshold. The fork's prototype is architecturally wrong for the class that is 80–90% of rows.
- **Best for a segmented/shared-window codec:** a realistic mixed segment reaches **0.012–0.013** — a **~23× win over the fork's per-row sealer** on the same bytes, before counting the row/index overhead the segment also eliminates.

### 3.2 The codec unit must be the frame, not the event

The compression unit inside OSES is a **frame = many events, one LZ window**. Per-event framing is not a "tune the threshold" problem — it is structurally incapable of compressing the count-dominant class. The codec design therefore:

1. **Never frames a single tiny event.** All events join a frame; the frame is what gets compressed. Thresholds apply only to jumbo/singleton decisions (a >64 KiB raw event gets its own frame), never to "is this event worth compressing."
2. **Frames are event-aligned, type-homogeneous where cheap.** The window-sensitivity curve (0.193 → 0.044 from 2 KiB → 64 KiB) says: **raise the microframe target to 16–32 KiB raw for the steer/snapshot classes** (research doc's 8–16 KiB underperforms by ~2× on the count-dominant class). The tool tail keeps jumbo singletons.
3. **brotli q1 is fine as the default; brotli q4 is worth it on steer-heavy frames** (0.071 → 0.035). zstd is not clearly better on event streams (the tool-tail anomaly in §2.2); keep brotli as the byte-stable baseline and treat zstd as a per-frame adaptive alternative, not the default.

### 3.3 The per-frame adaptive decision changes meaning

Fork/OPCL logic: "compress this row if stored+38 < raw" (24 B gain guard). For events the guard must be evaluated **per frame**, comparing:

```
frame_stored (incl. its share of the segment header/index/type-set, + per-event
ordinal/offset/length index bytes)  vs  sum(raw events in frame) + per-event index bytes
```

A steer frame almost always wins (window sensitivity shows 0.05–0.10 regardless of the 24 B guard, because the 14 B header is now amortized across hundreds of events). Incompressible content (a 100 KB base64 tool result) is still caught by the same per-frame guard → the frame stays raw or the event is promoted to its own jumbo singleton.

### 3.4 The index (not the codec) is where per-event cost lives

Since the codec compresses whole frames, the per-event overhead is now the **frame index** (event ordinal → decompressed offset/length, type key, elision flag) — ~5–10 B/event vs the 30 B `sessionID` + 14 B header + full row/B-tree entry per event today. The OSES §22.7 payload-index design is exactly right; this document confirms it must be counted in the frame-worth-it decision (§3.3), and that the 128–512 event/segment sweep in oses.md §2.2 is the right parameterization (a 32 KiB steer frame holds ~150–200 events → ~1–1.5 KiB index, well inside the budget).

### 3.5 Elision and dictionary — ship the hook, don't build the machinery first

Measured: within a warm frame they add ~0. So the sequence is:

1. **Ship segmentation + shared-window frames first** (the 23× lever). No elision, no dictionary needed to capture 90% of it.
2. **Ship `sessionID` elision** as a cold-start optimization for the first frame of each aggregate's sealed history and for the OPCL per-row path — but expect it to be a low-single-digit-% whole-DB effect once segmentation exists.
3. **Reserve the `dictionary_id` field** (codec IDs 4–7) but only build a structural dictionary if the *first-frame-of-aggregate* cost shows up as material in the corpus (the one place the window is cold).

---

## 4. Concrete codec-layer recommendations (delta over the swarm synthesis)

1. **Event frames are the compression unit; tiny events are never framed individually.** This is the single biggest codec decision and it is now measured, not hypothesized.
2. **Microframe target 16–32 KiB raw for steer/snapshot frames** (window sensitivity §2.3); jumbo singletons for >64 KiB events; keep `frame_count=1` legal for low-volume aggregates but **not** for the steer class (that would re-create per-row behavior at 32 KiB granularity).
3. **Per-frame adaptive codec**: brotli q1 default, brotli q4 for steer-heavy frames (2× better ratio, CPU is free in the sealer), zstd as a per-frame alternative only where it wins on the real corpus (it lost on my tool-tail probe).
4. **Per-frame worth-it guard** against `sum(raw events) + index` — replace the fork's 24 B/row guard; incompressible frames stay raw or split to singletons.
5. **Elision + structural dictionary = cold-start/secondary**, measured to be ~0 inside a warm frame. Ship the format hooks; don't block the first OSES cutover on them.
6. **The events are the strongest argument for OSES segmentation, not for per-row OPCL.** The research doc's OPCL-vs-OSES split is now backed by a 23× on the same bytes: OPCL per-row framing for projections (where median part = 29 B and rows are independently read), **segmented shared-window frames for events (where the same rows are range-read and share everything).**

---

## 5. What must be re-measured on the real corpus (not my synthetic payloads)

- Confirm the steer/snapshot/tool **mix** on a real multi-session DB (my mix is schema-driven but synthetic). The 23× figure is the *mechanism*; the population-level mix determines the whole-DB number.
- Verify brotli-q4-on-steer-frames vs zstd-l1 on the real tail (my probe showed brotli beating zstd on the 64 KiB tool stream — zstd's window behavior on real tool output must be checked).
- Measure the **first-frame-of-aggregate** cost (cold window) across short sessions to decide whether elision/dictionary pay for themselves.
- Confirm the index-bytes/event budget at 32 KiB steer frames on real type distributions.

**Bottom line:** the events are the best candidate for a *segmented* codec (23× measured) and the worst candidate for the *per-row* codec the fork shipped (0.976–1.000 on the count-dominant class). The codec's highest-leverage change is not a new codec at all — it is **making the frame, not the event, the unit of compression**, and sizing the frame window at 16–32 KiB.
