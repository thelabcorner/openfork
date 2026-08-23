# 05 — Roadmap, Risks & Testing Strategy

> **STATUS: WORKING DRAFT (Phase A groundwork)** — authored by migration-chief from independent
> reading of openswarm (`C:\Users\slooshied\Documents\openswarm`) and the host monorepo
> (`packages/*`, `AGENTS.md`). Sections marked **[DRAFT]** are pending synthesis against peer
> documents 01–04 (scout/architect/api-designer/ux-designer). Final version replaces this file;
> executive summary lands in `00-INDEX.md`.

---

## Sources read for this draft

| Source | What it established |
|---|---|
| `openswarm/README.md` | Feature surface, 711 tests / 2793 assertions, persistence at `<project>/.opencode/swarms/swarms.db`, `chunkdb` backend w/ auto-migration, model-selection chain, cache-economics data |
| `openswarm/docs/STORAGE.md` | Schema tables, `user_version` migration chain v1–v7, CAS blackboard, exactly-once claims, serialized write queue, key invariants |
| `openswarm/docs/SCHEDULER.md` | Task lifecycle, DAG readiness, atomic claims, leases (30 min default), retries (default 2), watchdog strikes, dependent notifications, human-chat guard |
| `openswarm/docs/MESSAGING.md` | Delivery state machine (`queued→scheduled→delivered/expired/failed`), exactly-once claim semantics, urgent TTL 60 min, retry budget 3, cooldown 30 s, `[DATA]` trust fencing |
| `openswarm/docs/DESKTOP.md` | Root-session topology, yield/lull semantics, V1+V2 permission engines, clamp-never-widens propagation, destructive-op gating |
| `openswarm/docs/OPENCODE_COMPATIBILITY_REPORT.md` | Live probe 14/14 vs OpenCode 1.18.15; `session.create` body constraints; promptAsync durability; parallel sessions |
| `openswarm/docs/ROOT_MEMBER_SESSIONS_PLAN.md` | Verified v1.18.15 host facts (root sessions, busy-runner absorption, parentID immutability, no parent-permission inheritance) |
| `openswarm/test/unit/` (63 files listed) | Test-suite inventory for the port map (§4) |
| Host `AGENTS.md` + `packages/*` listing | Monorepo conventions: package-scoped tests only (`do-not-run-tests-from-root`), `bun typecheck` per package dir, Effect-style architecture, V1-as-production-API doctrine |

---

## 1. Risk framework [DRAFT]

Severity scale: **S1** catastrophic (data loss / security breach / mass breakage) · **S2** major
(feature regression, hard-to-diagnose misbehavior) · **S3** moderate (degraded UX, extra work).
Likelihood: **H/M/L**. Owner-lane = which peer's synthesis must carry the mitigation.

### 1.1 Data-loss risks — **the #1 class**

Users run this plugin **in production today**. Every project that ever hosted a swarm has a live
SQLite database at `<project>/.opencode/swarms/swarms.db` (README.md:244) protected by an
append-only `user_version` migration chain currently at v7 (STORAGE.md §3). Any native port that
touches that file carelessly destroys user state that has **no backup anywhere else**.

| ID | Risk | Sev | Lik | Mitigation sketch | Lane |
|---|---|---|---|---|---|
| DL-1 | Native code opens an existing `swarms.db` with a divergent schema expectation and corrupts or strands it (e.g. assumes fresh install, or runs a non-idempotent migration) | S1 | M | Backup-before-touch policy: copy `swarms.db` (+ WAL/SHM siblings) to a timestamped sidecar before any native open that can mutate schema; keep the plugin's append-only `user_version` discipline; never rewrite shipped steps | api-designer (schema) + me (gate) |
| DL-2 | Dual-writer divergence during coexistence: plugin (Bun-bundled dist) and native core both process the same DB — double delivery, double task assignment, interleaved migrations | S1 | H if unmanaged | Mutual exclusion by design (§2.1): exactly one writer per DB per project, enforced by an ownership marker row checked at startup; native refuses to start while a live plugin instance holds the marker | architect + me |
| DL-3 | Data-movement surfaces beyond plain CRUD — **three** distinct vectors (per scout's source read): (a) `chunkdb` backend (README.md:106, compressed chunks over SQLite, auto-migrates on first open) vs legacy `sqlite` rows; (b) `mergeFromFile()` legacy-store folding (ATTACH + INSERT OR IGNORE, sqlite-store.ts ~1120); (c) `migrateSwarmDb()` full-copy path (storage/migrate.ts). A native reader/writer that mishandles any one strands user history | S1 | M | Storage adapter must support all three read+write before Phase 4 migration; round-trip tests per surface on real-world-shaped DBs | api-designer |
| DL-4 | Cascade deletes (`ON DELETE CASCADE` across 10 tables, STORAGE.md §7) triggered accidentally by a native bug (e.g. wrong swarm id resolution) wipes members/tasks/messages/beliefs irrecoverably | S1 | L | Keep confirm-gating (`swarm_delete` requires exact swarm name); add delete dry-run preview; WAL retention window so a recent pre-delete snapshot exists | api-designer |
| DL-5 | Terminal-state guards regress: `expired`/`failed` messages resurrected, terminal tasks rescheduled → duplicate side effects (double prompts to provider = real spend) | S2 | M | Port the store-level state guards verbatim; regression tests are non-negotiable ports (§4) | api-designer |
| DL-6 | Crash mid-migration leaves half-applied native schema; plugin then can't recognize its own DB | S2 | L | Preserve idempotent-step + defensive re-apply pattern (STORAGE.md §3); startup self-heal test on truncated-migration fixtures | api-designer |

### 1.2 Behavioral-regression risks — the 711-test suite encodes hard-won edge cases

The badge says 711 passing tests, but the *unit* tree alone is 63 files whose names are a map of
past incidents (`scheduler-edgecases-fix`, `messaging-guards`, `permission-wall-delivery`,
`stale-crossswarm-binding`, `manual-stop-fallback`, …). These are not generic coverage; they pin
specific failure modes that previously wedged or misled agents. A native rewrite that "reimplements
the idea" instead of porting the pinned contracts will silently reintroduce every fixed bug.

Highest-value behavior clusters to preserve (each traced to docs):

| ID | Behavior cluster | Evidence | Sev | Mitigation sketch | Lane |
|---|---|---|---|---|---|
| BR-1 | **Permission walls, two engines**: V1 (app/TUI, `permission.asked`/`permission.replied`, plugin `permission.ask` hook) vs V2 (headless, `permission.v2.asked`/`permission.v2.replied` over `/api/event` SSE, different reply endpoints). Member asks recorded from either engine flagged `v1`/`v2`; polling backstop catches missed asks; session re-root healing via `session.next.moved` (README.md:61–62) | README Security §; DESKTOP.md §3 | S2 | Native implementation must keep dual-engine handling + polling backstop + reroot healing; port `permission-wall-delivery`, `permissions-escalation`, `permission-lifecycle` tests as contract tests | architect |
| BR-2 | **Yield/lull races**: human-chat detection (self-injection registry + prefix fallback), suppression of mail/continue/scheduler while chatting, lull resume, `swarm_release` force-resume, restart lapse reconciliation (DESKTOP.md §2; ROOT_MEMBER_SESSIONS_PLAN §5.3.2 state table, E1–E14 matrix) | DESKTOP.md §2 | S2 | Port the state machine table verbatim; fake-clock tests (`humanchat.test.ts`) move nearly 1:1 | ux-designer + architect |
| BR-3 | **Crash recovery**: respawn vanished members, revive interrupted-but-alive members, stale `scheduled` mail → `queued` at startup, expired-scheduled NOT resurrected (MESSAGING.md §1, §3) | MESSAGING.md §1/§3 | S1 | Recovery reconciliation is a native service with the same startup contract; kill-the-server integration tests | architect |
| BR-4 | **Exactly-once mailboxes**: `markMessagesScheduled` affected-row count is the claim truth; concurrent wakes cannot double-deliver; delivered-commit guards expiry passing mid-delivery; sender gets exactly one expiry notice (MESSAGING.md §1–§3) | MESSAGING.md §1–3 | S1 | Keep claim-CAS at the store layer; concurrency tests with N racing wakes are mandatory ports | api-designer |
| BR-5 | **Lease & retry economics**: lease 30 min default, leaseSweep runs BEFORE scheduler pass in same sweep (reclaimed capacity usable immediately), release-counts-as-retry with `countAsRetry:false` exemptions for kickoff-failure/orphan releases, `maxRetriesPerTask` boundary 0 = fail-after-first-real-attempt (SCHEDULER.md §4–5) | SCHEDULER.md §4–5 | S2 | Port sweep ordering invariant explicitly; `leases-retries`, `scheduler-watchdog-budget` tests port with only seam rewrites | architect |
| BR-6 | **Watchdog subtleties**: nudge message excluded from liveness check (watchdog must not feed itself), strike-3 escalation, taskless-working demotion with 2-min kickoff grace, human chat counts as liveness (SCHEDULER.md §7) | SCHEDULER.md §7 | S2 | Fake-clock unit ports; these regress quietly and cause livelocks | architect |
| BR-7 | **Ownership invariants**: single conditional-UPDATE claim CAS; member-side second-task rejection; ownership guard rejecting binding another member's task; reassignment invalidates old owner's completion authority (SCHEDULER.md §3, §6; STORAGE.md §7) | SCHEDULER.md §3/§6 | S1 | Store-layer invariants port unchanged; property/concurrency tests mandatory | api-designer |
| BR-8 | **Delivery verdicts truthfulness**: `sendMessage` returns post-wake state (`deliveredTo`/`pendingFor`), attempt_count counts failures only, cooldown 30 s spacing, urgent bypass (MESSAGING.md §2, §4–5) | MESSAGING.md §2/§4–5 | S3 | Tool-output rendering contracts port; `noreply`, `flood-rate-control`, `delivery-audit` tests | api-designer |
| BR-9 | **Model selection chain**: explicit → last-used (persisted `context/model/last-used`) → coordinator's live model → config default → any-available fallback, with truthful `modelSource` reporting; capability delegation cheapest-capable-first (README Model selection §) | README.md:145–166 | S3 | Port chain order + reporting; `model-selection`, `model-management`, `capability-delegation` tests | api-designer |

### 1.3 Security risks

The plugin's security posture is deliberate and conservative; a native port inherits it as a
**floor**, never a ceiling.

| ID | Risk | Sev | Mitigation sketch | Lane |
|---|---|---|---|---|
| SEC-1 | Permission-inheritance widening: propagated rulesets must stay strictly narrower than the coordinator's. Clamp is monotone: only `edit` may propagate as `allow`; `bash`, `webfetch`, `external_directory` are ALWAYS `ask` even when coordinator allows them; per-command bash object rules never propagate (DESKTOP.md §4) | S1 | Reimplement clamp as pure function + exhaustive property tests ("never wider" fuzz); keep Case A/B/C classification diagnostics | architect |
| SEC-2 | Path-boundary bypass: scoping must reject substring siblings (`C:/repo/app` vs `C:/repo/app-evil`), any `..` segment, bare-`*` bash patterns; empty-worktree legacy still never blanket-allows bash (DESKTOP.md §3) | S1 | Boundary checker as isolated module with adversarial test corpus ported from `tools.test.ts` permission block | architect |
| SEC-3 | Injected-content fencing decay: peer-authored text must render fenced (`> [DATA] …` inbox; full `[DATA — untrusted…]` elsewhere) at EVERY render surface — envelopes, probe/status output, notices, task prompts (MESSAGING.md §8). One unfenced render = prompt-injection channel between peers | S1 | Central fence renderer; lint/test asserting every render path wraps untrusted content; `fencing.test.ts` ports + new surfaces added | api-designer |
| SEC-4 | Destructive-op gating weakened in native UI: `swarm_delete` (exact-name confirm, coordinator-only), `swarm_stop` (explicit member name, releases owned task first), `swarm_remove` (DESKTOP.md §6) | S2 | Gate at the service layer, not the tool layer, so future surfaces inherit it | api-designer |
| SEC-5 | Guest escalation: external guests must never receive tasks, never be respawned, never reach coordinator-only tools; `allowExternalGuests:false` opt-out honored (README.md:45) | S2 | Role-based authorization checks centralized in core, tested per-tool | api-designer |
| SEC-6 | New native attack surface: HTTP routes / events exposing swarm internals could leak peer content or allow forged control calls | S2 | Auth scope review in API design phase; treat swarm control endpoints as privileged | api-designer |

### 1.4 Ecosystem risks

| ID | Risk | Sev | Mitigation sketch | Lane |
|---|---|---|---|---|
| EC-1 | Existing plugin users stranded: current installs register `dist/index.js` via `opencode.json` `plugin` array (README.md:86–98). If native ships and users upgrade host without touching config, BOTH may load → DL-2 | S1 | Coexistence design (§2) makes simultaneous activation impossible-by-detection, not by documentation | me |
| EC-2 | Third-party plugins/scripts calling `swarm_*` tool names or parsing output shapes break on native rename/re-shape | S2 | Tool names + output shape frozen during coexistence window; additive changes only; deprecation aliases before removal | api-designer |
| EC-3 | Config drift: plugin options (`allowAllMemberPermissions`, `defaultMemberModel`, `storeBackend`) vs new native config keys confuse users mid-window | S3 | Native config accepts/supersedes plugin options with documented mapping; probe warns on both-present | api-designer |
| EC-4 | Docs/community divergence: README badges, quickstart, and tool reference describe plugin reality; native changes behavior subtly (e.g. spawn visibility) → support burden | S3 | Single migration guide; version-gated docs; changelog discipline | me |

### 1.5 Performance risks

Measured baseline exists (README Caching §): swarm sessions show ≈98% median cache-hit ratio vs
≈92% regular; effective per-token cost ~2.7× cheaper, driven by **shared session lineage** (all
members re-read the same projected history; first runner warms, rest hit).

| ID | Risk | Sev | Mitigation sketch | Lane |
|---|---|---|---|---|
| PF-1 | Cache-warmth regression: native spawn/session plumbing that forks separate histories or changes projection breaks shared lineage → silent multi-x cost increase | S2 | Preserve shared projected-history mechanics; add cache-hit-ratio assertion to perf smoke; watch <95% alert threshold (README.md:184) | architect |
| PF-2 | Sweep/load regressions: 10 s safety-net sweep + expiry sweep + watchdog pass on every swarm; naive native port (per-swarm timers, O(n²) readiness recompute) degrades with many swarms/projects | S3 | Event-driven passes with safety net preserved; benchmark fixture with synthetic large DAGs | architect |
| PF-3 | SQLite contention: single shared connection + serialized promise queue (STORAGE.md §1/§4) is load-bearing; replacing with pooled writers reintroduces lost-update windows | S1 | Keep single-writer serialization semantics at the native storage layer; concurrency regression tests port | api-designer |
| PF-4 | Spawn storms: capability delegation + retries can spawn repeatedly; each spawn forfeits cache warmth (README.md:178) | S3 | Keep batching guidance; cap respawn rate; metrics on spawn churn | architect |

---

## 2. Compat & coexistence skeleton [DRAFT]

Goal: at no point may two controllers drive one `swarms.db`, and at no point may an upgrade
destroy or strand user data. Skeleton now; concrete mechanics land after architect/api-designer
synthesis.

### 2.1 Dual-run window design

- **Principle: one writer per database.** The DB gains (or reuses) an ownership record identifying
  the controlling implementation (plugin vs native) + a heartbeat. Startup of either controller
  checks the record: foreign live controller ⇒ stand down (native logs + disables itself; plugin
  keeps working) rather than race.
- **Flag-gated native:** native core ships dark behind a config flag (name TBD — candidate
  `swarm.native.enabled` or experimental namespace per host config conventions). Default OFF
  through Phases 1–3.
- **Opt-in cutover:** user enables native for a project ⇒ pre-flight check (no live plugin
  controller, DB readable, backup taken) ⇒ native takes ownership marker ⇒ plugin instances in
  that project detect the marker and become inert (tools return a clear "native owns this swarm"
  notice instead of acting).
- **Reverse path:** disabling the flag releases ownership; plugin resumes control. Both directions
  must be non-destructive (schema-compatible operations only during the window).

### 2.2 Kill switch

- Env-level instant off: e.g. `OPENCODE_SWARM_NATIVE=0` overrides config, disables native swarm
  machinery at next start (and ideally hot-disables scheduling sweeps).
- Failure containment: native bugs must never take down unrelated host functionality — swarm
  subsystem isolates its errors (host convention: swarm machinery already yields to user chats).
- Rollback story: because the plugin remains installed and the DB remains plugin-compatible
  throughout the window, rollback = flip flag off (+ restart). Documented as THE recovery path.

### 2.3 Plugin deprecation policy [DRAFT — timeline numbers pending synthesis]

1. **Window open (Phase 1–3):** plugin fully supported; native opt-in; docs describe both.
2. **Soft deprecation (Phase 4 entry):** plugin emits startup deprecation notice pointing at native
   enablement + migration guide; no removal.
3. **Migration assist (Phase 4):** one-command data migration/ownership transfer for existing
   `swarms.db`; passive compatibility for users who never migrate (their plugin keeps functioning
   until removal).
4. **Hard removal (post-Phase 4, versioned):** plugin stops loading on newer hosts (or is
   formally archived upstream); native reads old DBs forever (read-compat commitment).

---

## 3. Testing port plan [DRAFT]

### 3.1 Monorepo conventions (from host `AGENTS.md`)

- Tests **never run from repo root** (guard: `do-not-run-tests-from-root`); run from package dirs,
  e.g. `packages/opencode`.
- Typecheck via `bun typecheck` from package directories, never raw `tsc`.
- Avoid mocks/globalThis where possible; test real implementations.
- Style: Effect-flavored core, package dependency direction enforced (Schema→Core→Protocol→Server;
  client may use Schema+Protocol, never Core/Server).

### 3.2 Destination mapping (63 files → native packages)

Working hypothesis: swarm core lands as its own package (candidate `packages/swarm` or a
namespace inside `packages/opencode/src` — architect decides; my plan works either way). Tests
travel with their layer:

| Openswarm test cluster (files) | Destination | Treatment |
|---|---|---|
| `store.test.ts`, `schema-drift.test.ts`, `chunkdb-store.test.ts` | storage layer tests | Port near-verbatim; drift test becomes schema-source-of-truth guard for native schema |
| `dag.test.ts`, `leases-retries.test.ts`, `reservation.test.ts`, `scheduler-*.test.ts` (bundle/edgecases-fix/robustness/stickiness/watchdog-budget) | scheduler/core tests | Port; swap fake-runtime seams for native test doubles |
| `messaging.test.ts`, `messaging-guards.test.ts`, `need.test.ts`, `noreply.test.ts`, `notices*.test.ts`, `delivery-audit.test.ts`, `flood-rate-control.test.ts`, `mentions.test.ts`, `guest-messaging.test.ts` | messaging tests | Port; envelope-render assertions kept byte-stable during coexistence |
| `humanchat.test.ts` | session-integration tests | Port state machine with fake clock; E1–E14 matrix preserved |
| `autopermissions.test.ts`, `permissions-escalation.test.ts`, `permission-lifecycle.test.ts`, `permission-wall-delivery.test.ts` | permission tests | Rewrite against native permission seams (V1/V2 engines); adversarial boundary corpus MUST survive |
| `fencing.test.ts` | rendering/trust tests | Port + extend to every new native render surface |
| `hive-*.test.ts`, `corpse-gold.test.ts`, `digest*.test.ts`, `wip-aura.test.ts`, `match.test.ts` | hive tests | Port as-is (pure logic mostly) |
| `cross-swarm*.test.ts`, `cross-memory.test.ts`, `memory-share.test.ts`, `stale-crossswarm-binding.test.ts`, `multi-swarm.test.ts` | multi-swarm tests | Port; cross-db attach patterns re-verified on native storage |
| `models.test.ts`, `model-*.test.ts`, `capability-delegation.test.ts` | model/provider tests | Port chain-order + reporting contracts |
| `emergency.test.ts`, `stalls.test.ts`, `failure-detection.test.ts`, `transport-resilience.test.ts`, `manual-stop*.test.ts`, `removal-grace.test.ts`, `revive.test.ts` | reliability tests | Port; crash/restart scenarios become integration tests against real storage |
| `core.test.ts`, `edge-cases.test.ts`, `contracts.test.ts`, `timeline.test.ts`, `subscriptions.test.ts` | core/domain tests | Port with seam rewrites |
| `tools.test.ts` | tool-surface contract tests | REWRITE against native tool registry; permission boundary cases preserved 1:1 |
| `runtime.test.ts` | runtime adapter tests | Likely REWRITE/die — if native removes the adapter indirection, tests fold into integration |
| `probe-compat.test.ts` | — | DIES with the probe harness (plugin-era artifact); replaced by native capability smoke if needed |

### 3.3 Port rules

1. **Contract-preserving port first, elegance later.** Each ported test keeps its assertions until
   the native implementation demonstrably satisfies them; only then may a test be refactored.
2. **No test dies silently.** Every file above is mapped; anything unmapped at synthesis time is a
   bug in this document (editor duty).
3. **Concurrency/exactly-once tests are P0 ports** (BR-4/BR-7/PF-3): they are the ones whose loss
   costs users money and data.
4. Integration tier: kill-and-restart scenarios (crash recovery, lease expiry across restart,
   migration interruption) run against real SQLite files in temp dirs, mirroring `bun run e2e`
   intent but inside package-scoped harness.
5. CI placement follows host conventions (package scripts; turbo pipeline picks them up).

---

## 4. Acceptance criteria per phase [DRAFT — to finalize at synthesis]

### Phase 0 — Discovery (this investigation)
- All four peer docs (01–04) landed and read; contradictions resolved via direct peer messages and
  recorded in the DECISION LOG (00-INDEX.md).
- Consolidated risk register (this file §1) with owners per lane.
- Capability map, target architecture, API/data design, UX plan mutually consistent (routes,
  module placements, naming cross-checked).
- Open-questions ledger seeded with honest UNKNOWNs (00-INDEX.md).

### Phase 1 — Native core behind flag
- Core domain (membership, mailbox broker, blackboard CAS, DAG scheduler, storage adapters for
  BOTH `chunkdb` and `sqlite` backends) implemented natively, flag-gated OFF by default.
- Ported test clusters green in-package (storage, scheduler, messaging, hive, reliability ≥ the
  P0 set in §3.3.3).
- Dual-run mutual exclusion proven: native + plugin simultaneously present ⇒ exactly one acts.
- Zero writes to existing `swarms.db` unless the user opts in (flag ON).
- `bun typecheck` clean in the owning package(s); no root-level test invocation anywhere.

### Phase 2 — API + SDK surfaces
- `swarm_*` / `hive_*` / `artifact_*` parity surface exposed natively (tool registry and/or HTTP
  routes per api-designer's 03 doc); SDK regeneration path honored if Protocol/Server HttpApi
  changed (`bun run generate` from `packages/client`; generated dirs never hand-edited).
- Fencing guarantee verified on every new render surface (SEC-3).
- Output-shape compatibility with plugin era maintained for coexistence (EC-2) or aliased.
- Package dependency direction respected (client never imports Core/Server).

### Phase 3 — UX surfaces
- Desktop/web/TUI: member sessions visible/openable as normal chats; swarm dashboards; permission
  asks resolvable in-app for both engines (BR-1); yield/lull behavior observable (`chatting`
  indicators, `swarm_release`).
- Human-chat doctrine parity: user-can-talk-to-member semantics identical to plugin era (E1–E14).
- Desktop verification performed against `bun run dev` from `packages/desktop` (never a packaged
  exe) per host AGENTS.md.

### Phase 4 — Data migration + deprecation
- One-command, backup-first migration of existing `swarms.db` (both backends) to native ownership;
  interrupted-migration self-heal proven (DL-6).
- Soft-deprecation notices live; migration guide published; passive users unaffected.
- Kill switch + rollback drill executed end-to-end (flip back to plugin on a migrated-then-reverted
  project).
- Read-compat commitment documented: native reads pre-migration DBs indefinitely.

---

## 5. Rollout / rollback strategy summary [DRAFT]

- **Roll forward:** flag OFF → opt-in per project → pre-flight (backup, no rival controller) →
  native owns → verify → (later) deprecate plugin.
- **Roll back:** flag OFF (+ restart) returns control to plugin at any point before hard removal;
  DB stays plugin-compatible during the entire window; backups precede every schema-touching step.
- **Blast-radius rule:** any S1 risk trigger (DL-*, SEC-*) halts phase exit until mitigated —
  phases gate on risk closure, not calendar.

## 6. Open questions ledger (seeded; grows at synthesis)

| # | Question | Why it matters | Owner |
|---|---|---|---|
| Q1 | Exact native home: new `packages/swarm` vs namespace under `packages/opencode/src`? | Determines test placement + dependency-direction compliance | architect |
| Q2 | Ownership-marker mechanics for mutual exclusion (row? pragma? lockfile?) | DL-2 mitigation concreteness | architect + api-designer |
| Q3 | Does native reuse the plugin's `user_version` chain or fork schema identity? | Migration safety (DL-1) | api-designer |
| Q4 | Which surfaces get HTTP routes vs tool-registry-only? | Phase 2 scope + SDK regeneration need | api-designer |
| Q5 | TUI scope for Phase 3 (full dashboards vs minimal status)? | UX effort sizing | ux-designer |
| Q6 | Timeline numbers for deprecation policy (§2.3) | Ecosystem communication | me + coordinator |
| Q7 | Are there third-party plugins actually depending on `swarm_*` today? | EC-2 severity calibration | scout |
