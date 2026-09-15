# SnapEye First-Party Browser — Implementation & Certification Ledger

Status: **implemented and certification-green in the feature worktree; not yet committed**  
Branch: `feature/snapeye-first-party`  
Worktree: `/webstormprojects/opencode-wt-snapeye`  
Last certification pass: 2026-09-15  
Visual engine: `@zumer/snapeye` **0.4.0** + `@zumer/snapdom` **3.0.0**, exact-pinned  
SnapEye protocol/schema: **v1**

This document supersedes the original design-only version of this plan. The architecture below is the architecture now implemented in the worktree, and the certification sections distinguish experimentally proven behavior from policy boundaries and non-goals.

---

## 1. Product contract

SnapEye is now a first-party **visual-observation layer** in OpenCode's browser system.

It works through both existing browser lanes:

1. OpenCode Desktop's sandboxed Electron `<webview>` lane.
2. The OpenCode Chrome extension + native-messaging/CDP lane.

Target applications do **not** need to install SnapEye, add a Vite plugin, expose `window.snapeye`, run a SnapEye HTTP endpoint, or otherwise participate in the integration.

The division of responsibility is intentionally narrow:

> OpenCode owns navigation, interaction, tab authority, permissions, transport, and persistence. SnapEye owns deterministic DOM capture, comparison, region extraction, and bounded visual recording.

SnapEye is not a third browser-control transport and does not replace compositor screenshots. The two observation modes answer different questions:

- compositor screenshot: what Chromium visibly displays right now;
- SnapEye: whether a deterministic SnapDOM render matches an approved reference, where it changed, and what deterministic capture produced that verdict.

---

## 2. Implemented topology

```text
agent / browser tool / Visual Inspector
              |
              v
      BrowserHostBroker
              |
              v
       Desktop BrowserHost
              |
      +-------+--------+
      |                |
      v                v
 Electron webview   Chrome extension
 isolated world     MV3 + isolated world
      |                |
      +-------+--------+
              |
              v
   @opencode-ai/browser-visual
    SnapEye + SnapDOM adapter
              |
              v
 logical bounded ArtifactStore RPC
              |
              v
 VisualObservationCoordinator
              |
              v
 host-owned project/.snapeye
```

The critical invariant remains: **large visual artifacts never travel in ordinary `BrokerResponse` objects**. Browser responses remain compact semantic data. PNG/SVG/GIF/video/baseline bytes use the dedicated bounded artifact path.

---

## 3. Shared visual runtime

The browser-safe runtime lives in `packages/browser-visual` and wraps the published SnapEye client rather than copying or deep-importing private SnapEye implementation files.

Key properties:

- exact-pinned SnapEye/SnapDOM versions because renderer upgrades can change baseline pixels;
- SnapEye's public `ArtifactStore` seam is the persistence boundary;
- SnapDOM is supplied directly to SnapEye;
- capture/diff use upstream stabilization + settling defaults;
- record intentionally does not stabilize motion;
- OpenCode overlays are excluded from persisted visual artifacts;
- declarative OpenCode redaction is applied on the detached capture clone;
- cancellation is reasserted as `AbortError` if upstream error normalization wraps an interrupted persistence operation;
- GIF recording uses an OpenFork-owned bounded/global-palette encoder hook instead of SnapEye's default PnnQuant-derived quantizer;
- the same runtime executes in Electron's isolated world and Chrome's extension isolated world.

### 3.1 Internal timing provider

Chrome has one important first-party timing adaptation.

Upstream SnapEye's stability algorithm prefers page `requestAnimationFrame`. On inactive Chrome tabs, RAF may not fire and page fallback timers can be throttled toward one second. Several settle/freeze frames therefore produced an observed ~6 second floor for otherwise trivial background-tab diffs.

OpenCode now gives the Chrome visual runtime an **internal timing facade**:

- SnapEye's settle/freeze algorithm and number of frame waits are unchanged;
- page RAF is hidden from SnapEye for this lane;
- its documented `wait` hook is routed through bounded MV3 service-worker timers;
- Electron keeps native RAF behavior;
- there is no SnapEye fork and no model-facing timing option.

Real two-tab inactive-page measurements after the fix:

```text
warm concurrent diff rounds: [240, 246, 212, 213, 234] ms
median:                     234 ms
p95 sample:                 246 ms
```

The pre-fix diagnostic run was ~6005 ms. The post-fix measurement is multi-sample; the pre-fix number is retained as a diagnostic comparison, not presented as a statistically sampled benchmark.

---

## 4. Browser dispatch provenance

Visual operations preserve the trusted broker provenance required to derive project storage and cancellation authority.

The Desktop host now carries a full dispatch context rather than reducing a request to `(tabId, operation, sessionId)`:

```ts
interface BrowserDispatchContext {
  requestId: string
  sessionId: string
  windowId: string
  workspaceId?: string
  directory?: string
  messageId: string
  toolCallId?: string
  timeoutMs: number
  signal?: AbortSignal
}
```

The project directory always comes from this trusted broker context. Browser/page code cannot choose an arbitrary persistence root.

`visual_history` and `visual_artifact` are intentionally **project-scoped host operations**, not tab operations. They do not require a live browser tab and are never forwarded into a page or Chrome content context.

---

## 5. Capability model and host authority

`VisualObservationCoordinator` is the host authority for capture/diff/record transactions.

Each operation receives a random opaque capability of at least 192 bits, bound to:

- broker request ID;
- session/project directory;
- lane;
- tab ID;
- visual operation;
- baseline name;
- run ID;
- environment fingerprint;
- normalized redaction policy;
- expiration/deadline;
- operation byte budget.

Possession of the token does **not** grant a path API. The browser runtime can invoke only logical ArtifactStore operations permitted by that grant.

Capabilities are terminally revoked on:

- successful `result.json` commit;
- caller abort;
- timeout/expiry;
- navigation;
- tab destruction/close;
- guest destruction/crash;
- human takeover;
- Desktop/controller shutdown;
- lane/transport interruption.

No timed-out or interrupted operation may later publish a terminal result.

---

## 6. Persistence contract

OpenCode preserves the upstream-compatible layout:

```text
.snapeye/
  .gitignore
  baselines/
    <name>.png
    <name>.json
  runs/
    <runId>/
      current.png
      current.svg
      diff.png
      frames.png
      recording.gif
      recording.webm | recording.mp4
      result.json
```

`.snapeye/.gitignore` preserves user content while ensuring:

```text
runs/
*.tmp
```

Baselines remain trackable/committable.

### 6.1 Host invariants

`OpenCodeSnapEyeStore` enforces:

- strict name/run/filename validation rather than lossy sanitization;
- no traversal segments, separators, control characters, hidden baseline names, or temp artifact names;
- canonical trusted project root;
- no `.snapeye`, `baselines`, `runs`, run-directory, or artifact symlink/junction escape;
- no-follow reads where appropriate;
- fixed artifact allowlists by operation;
- per-artifact size ceiling;
- chunk offset and declared-size enforcement;
- atomic temporary-file writes;
- serialized baseline replacement;
- SHA-256 + byte-length binding for OpenCode-created baseline PNGs;
- a pending/committed baseline marker so interrupted replacement cannot publish a mixed PNG/metadata pair;
- `result.json` single-assignment and written last;
- no artifact writes after a run becomes terminal;
- terminal history only;
- bounded JSON inspection;
- retention that prunes only old terminal runs, never baselines or in-flight work;
- cleanup of unfinished temp state on abort/shutdown.

Default host ceilings currently include:

```text
artifact maximum:          64 MiB
extension raw chunk:       384 KiB
Electron IPC chunk:          2 MiB
capture transport budget: 128 MiB
diff transport budget:    256 MiB
record transport budget:  256 MiB
terminal run retention:        20
renderer preview default:  16 MiB
```

Chrome base64 expansion occurs only on the native-messaging JSON path. Electron moves typed bytes without base64.

### 6.2 Baseline replacement concurrency

Baseline replacement is serialized per baseline. An aborted replacement leaves the previously committed PNG/metadata pair intact. Setup failures release the mutex as well; a replaced/junction `baselines/` directory cannot poison that baseline's lock indefinitely.

---

## 7. Environment and redaction identity

OpenCode adds an additive metadata envelope to its baselines/results:

```json
{
  "opencode": {
    "schemaVersion": 1,
    "lane": "webview | extension",
    "platform": "...",
    "engine": "chromium",
    "engineMajor": 152,
    "appearance": "light | dark | system",
    "snapeyeVersion": "0.4.0",
    "snapdomVersion": "3.0.0",
    "redactionPolicySha256": "..."
  }
}
```

Known incompatible OpenCode fingerprints fail closed rather than silently diffing unlike environments. Ordinary upstream SnapEye baselines without the OpenCode envelope remain intentionally admissible for interoperability.

Current compatibility comparison includes lane, platform, engine, engine major, appearance, SnapEye version, SnapDOM version, and normalized redaction digest where both sides provide the field.

### 7.1 Declarative redaction

Public redaction is bounded and declarative:

```ts
redact?: {
  blocks?: string[]
  attributes?: Array<{ selector: string; names: string[] }>
}
```

Block redaction uses layout-preserving SnapDOM exclusion. Attribute redaction runs against the detached capture clone, including reflected live `value` state where needed. Arbitrary user/model plugin functions are not accepted.

The normalized redaction policy is SHA-256 fingerprinted into baseline identity. Equivalent order/duplicate/case forms canonicalize to the same policy; semantic changes make a baseline incompatible rather than producing a misleading diff.

---

## 8. Public browser/tool surface

The existing `browser` gateway remains the single browser family. First-party operations are:

```text
visual_capture
visual_diff
visual_record
visual_history
visual_artifact
```

Delegated agent tools are exposed as:

```text
browser_visual_capture
browser_visual_diff
browser_visual_record
browser_visual_history
browser_visual_artifact
```

Capture is intentionally baseline-replacing. Diff never silently recaptures a baseline. Record is bounded motion observation. History/artifact return compact project metadata/descriptors rather than dumping image/video bytes into model context.

### 8.1 Targeting

Visual observation accepts:

```ts
type VisualTarget =
  | { kind: "document" }
  | { kind: "css"; selector: string }
  | { kind: "element"; target: ElementTarget }
```

`ElementTarget` reuses OpenCode's existing ref / locator / coordinate resolution rather than introducing a visual-only selector engine.

Chrome's element-target path attaches CDP only when required to resolve an OpenCode-native target. Document/CSS visual capture remains debugger-free.

The Chrome snapshot/ref store is now real and versioned; the previous permissive unknown-ref fallback is not used by visual targeting.

---

## 9. Public resource bounds

The protocol rejects resource-amplifying values before they reach Chromium.

Representative public ceilings:

- baseline name: strict 1–64 character identifier contract;
- run id: strict 1–64 character identifier contract;
- CSS selector: ≤4096 characters;
- redaction block selectors: ≤64;
- redaction attribute rules: ≤64;
- attribute names per rule: ≤32;
- record duration: ≤15,000 ms;
- record FPS: ≤30;
- SnapEye frame ceiling: 150;
- scale: 0.1–2;
- SnapEye total record pixel ceiling: 120,000,000 frame-pixels;
- filmstrip cells/columns: bounded;
- filmstrip width/gap: bounded;
- media bitrate: ≤20,000,000 bits/s;
- diff tile/gap/region controls: bounded;
- wait/readiness timeouts: bounded;
- visual broker timeout: ≤120,000 ms;
- history/artifact host timeout: ≤30,000 ms;
- history result request: ≤100 runs / ≤200 baselines.

These are security/resource boundaries, not merely UI validation.

---

## 10. Electron lane

Electron keeps the ordinary guest preload lightweight. The heavy SnapEye/SnapDOM runtime is a distinct production entry:

```text
out/preload/preview.js
out/preload/visual-runtime.js
```

`WebviewVisualController` first probes the isolated preload world for the runtime. It reads/evaluates the heavy bundle only when absent, then reuses it for warm operations in that document.

The proven security configuration remains:

```text
sandbox: true
contextIsolation: true
nodeIntegration: false
```

The page itself never receives Electron IPC or the visual artifact capability.

Navigation, guest destruction, user close, annotation takeover, caller abort, and unmatched genuine human input interrupt active visual work. Expected echoes of the agent's own synthetic input are consumed and do not self-cancel the operation.

---

## 11. Chrome extension lane

The normal content script remains lightweight. The visual engine is **not** a document-start content script.

On first visual use in a document:

1. service worker probes the extension ISOLATED world for the installed runtime;
2. if absent, it injects the prebuilt `visual.bundle.js` with `chrome.scripting.executeScript()`;
3. concurrent first-use callers share one installation flight;
4. installation readiness is verified;
5. failures are evicted so a later cold document can retry;
6. warm operations do not reparse/reinject the bundle.

Navigation naturally destroys that document's isolated world, so a later operation in the new document performs one new cold injection.

### 11.1 Artifact transport

Visual artifact RPC is independent of ordinary BrowserHost request/result flights.

Native-messaging constraints remain asymmetric:

```text
native host -> extension:  ~1 MiB frame ceiling
extension -> native host: much larger sanity ceiling
```

Raw visual chunks are conservatively 384 KiB so base64 + JSON framing remain below the host-to-extension ceiling.

Baseline reads and artifact writes are both chunked and correlated independently. Disconnect/reconnect and out-of-order artifact responses are test-covered.

### 11.2 Human/lifecycle authority

Trusted interaction listeners exist **only while visual work is active**. Ordinary browsing has no permanent SnapEye pointer/key/wheel listener cost.

Active Chrome visual flights are explicitly tracked by request and tab. The first interruption reason is sticky until the owning dispatch unwinds. Trusted input, navigation start, tab removal, and caller abort all produce canonical `BrowserControlInterrupted` behavior.

The tab-close race where a pending `tabs.sendMessage` loses its responder before `tabs.onRemoved` fires is handled as browser-context disappearance rather than a generic operation failure.

---

## 12. Determinism and readiness semantics

OpenCode preserves upstream SnapEye semantics rather than broadening them implicitly.

### 12.1 What automatic settling means

SnapEye's automatic `settle` detector is intentionally **geometry-oriented**. It watches document readiness, page dimensions, image/style-sheet counts, and target geometry until stable.

Therefore:

- geometry-changing cold hydration is automatically settle-able;
- paint/text-only asynchronous work with unchanged geometry is **not** guaranteed to be detected by settle;
- late image/font/app paint should use explicit `waitFor` readiness when application state matters.

This is a documented operating contract, not an OpenCode regression.

### 12.2 Motion

CSS animations/transitions are stabilized for capture/diff using upstream SnapEye behavior. Record intentionally observes motion.

Imperatively animated Canvas/WebGL is not something CSS stabilization can freeze. Use `visual_record` for that class of motion rather than claiming capture/diff can choose a deterministic imperative frame.

---

## 13. Visual history, preview, and approval UI

The Desktop browser panel has a first-party lazy `VisualInspector` workbench.

It provides:

- workspace-scoped baseline list;
- terminal run history;
- baseline/current/diff review;
- changed verdict and region metadata;
- recording filmstrip/GIF review;
- environment/redaction identity information;
- bounded artifact preview;
- exact human **Approve current as baseline**.

The inspector is a lazy dynamic import and is not parsed with the ordinary browser panel until explicitly opened.

Renderer preview goes through trusted Desktop IPC and re-enters the coordinator/store. It does not convert a project-relative descriptor into arbitrary renderer filesystem access.

Video descriptors are intentionally open-only at this layer rather than copying arbitrary video bytes into renderer memory.

### 13.1 Approval invariant

Approval does **not** recapture the live page.

It atomically promotes the exact terminal `current.png` produced by the reviewed successful diff, preserving the run's:

- baseline name;
- target identity;
- image dimensions/scale;
- environment metadata;
- redaction digest;
- reviewed pixels.

This prevents a human from reviewing state A and accidentally approving later state B.

---

## 14. Capability advertisement

Visual functionality is additive and does not require bumping the entire browser protocol.

Structured host capability advertisement identifies exactly supported operations/features, conceptually:

```json
{
  "visual": {
    "schemaVersion": 1,
    "snapeyeProtocolVersion": 1,
    "operations": ["capture", "diff", "record"],
    "features": ["history", "artifact"]
  }
}
```

A sidecar that does not receive an advertised feature fails locally rather than optimistically invoking unsupported host behavior. Legacy `visual: true` remains capture/diff-only compatibility behavior.

---

## 15. Recording and media

`visual_record` is implemented in both browser lanes with bounded frames/pixels/artifacts and prompt cancellation.

Real-browser certification includes:

- filmstrip PNG;
- GIF;
- video using the runtime-selected supported format (`recording.mp4` in current Windows Chromium/Electron verification);
- `format: "both"` producing filmstrip + GIF + video;
- 15-second MV3 recording;
- abort before completion with no terminal result;
- human takeover interruption;
- navigation interruption;
- tab-close interruption.

Observed 15-second cancellation in direct browser runtimes has been ~150–170 ms when cancellation is signaled directly to the shared adapter. End-to-end MV3 trusted-input/navigation/tab-close interruption includes browser event/message teardown and has remained under the 5-second certification ceiling, typically ~0.8–1.1 seconds in current runs.

### 15.1 GIF encoder provenance, quality, and bounds

SnapEye 0.4 statically imports `gifenc`. Its default quantizer is derived from PnnQuant.js (MPL-2.0). OpenFork does **not** ship that quantizer in either browser lane.

Instead:

- the top-level `gifenc` import is build-aliased to `packages/browser-visual/src/gifenc-safe.ts` in Chrome, Electron, and the fidelity harness;
- OpenFork injects `encodeGif` into `attachSnapEye()` through SnapEye's documented dependency seam;
- only `gifenc`'s MIT stream/LZW primitives are reused;
- palette analysis is first-party: a bounded 5-bit RGB histogram over at most 262,144 sampled pixels from at most eight evenly distributed frames;
- one deterministic median-cut palette is learned for the whole recording and reused across every frame, avoiding temporal palette churn and repeated local color tables;
- palette mapping uses a 32K-entry quantized-color cache;
- the encoder enforces the same 64 MiB single-artifact ceiling as host persistence.

Controlled quantization measurements on the certification machine:

| Fixture | OpenFork adaptive | Upstream PNN | Notes |
| --- | --- | --- | --- |
| sparse UI colors | 0 RMSE, ~5.7 ms | 0 RMSE, ~13.1 ms | exact colors in both |
| 2-D gradient | 4.28 RMSE / 35.5 dB, ~44.3 ms | 5.41 RMSE / 33.47 dB, ~23.4 ms | OpenFork higher fidelity |
| deterministic noise | 12.56 RMSE / 26.15 dB, ~690 ms | 12.16 RMSE / 26.44 dB, ~15.3 s | similar fidelity, bounded cost |

These are diagnostic measurements, not universal benchmarks. The permanent unit tests enforce deterministic output, exact sparse-color preservation, bounded gradient error, and valid deterministic GIF89a framing; the real Chromium, MV3, and Electron verifiers exercise actual GIF recording.

The real Chromium fidelity harness additionally feeds each generated `recording.gif` back into Chromium's independent WebCodecs `ImageDecoder` and decodes every frame. The certified animated Canvas/WebGL GIF and ordinary visual GIF each reported and decoded **2/2 frames** with consistent nonzero dimensions, providing an independent consumer check of the global color table, multi-frame LZW stream, and frame structure.

`bundle-budgets.ts` also scans both shipping visual bundles and fails if PnnQuant provenance markers reappear. A canonical `THIRD_PARTY_NOTICES.txt` covers SnapEye, SnapDOM, SnapDiff, and the MIT `gifenc` primitives. Chrome's generated notice is byte-compared during freshness checks; an actual Windows `electron-builder --dir` packaging pass verified the Desktop copy under `resources/licenses/` is byte-identical to the canonical notice.

The same packaging pass also inspected the produced `app.asar`: 8,399 packaged entries and **zero** paths matching `gifenc` or `pnnquant`. The MPL-derived quantizer is therefore absent from both executed visual bundles and the packaged Electron filesystem.

---

## 16. Performance and idle-cost architecture

The common case is **SnapEye unused**.

Enforced architectural rules:

- no SnapEye/SnapDOM import in ordinary Chrome content script;
- no SnapEye/SnapDOM import in ordinary Electron guest preload;
- no Visual Inspector eager import in normal browser panel;
- no visual artifact polling loop;
- no visual human-input listeners unless a visual operation is active;
- no eager baseline reads;
- no repeated heavy Chrome bundle parse for warm operations in one document;
- no base64 in Electron IPC;
- large artifacts remain outside normal broker results.

### 16.1 Shipping bundle budgets

The budget verifier now measures the **actual freshly built Desktop renderer**, not a possibly stale standalone app output, and fails when the production chunks are stale relative to their source entries. The Chrome extension builder is also hermetic to caller working directory and `verify:chrome-generated` rebuilds in check-only mode and byte-compares all committed extension bundles before MV3 or bundle certification proceeds.

Latest certified shipping sizes:

| Surface | Raw | gzip | Budget raw / gzip |
| --- | ---: | ---: | ---: |
| Chrome ordinary content | 16,129 B | 4,150 B | 25 KiB / 8 KiB |
| Chrome lazy visual runtime | 460,507 B | 123,927 B | 512 KiB / 160 KiB |
| Electron ordinary guest preload | 35,344 B | 9,914 B | 48 KiB / 16 KiB |
| Electron lazy visual runtime | 430,644 B | 121,730 B | 512 KiB / 160 KiB |
| Desktop ordinary browser panel | 112,805 B | 23,328 B | 128 KiB / 40 KiB |
| Desktop lazy Visual Inspector | 35,857 B | 7,361 B | 48 KiB / 12 KiB |

### 16.2 Representative active-operation metrics

Real Chrome isolated-world fixture, current machine/build:

- 4,000-node DOM capture: 504 ms in the latest umbrella certification run;
- 2,200-node SVG capture: 299 ms in the latest umbrella certification run;
- one clean standalone five-round inactive-tab sample after the performance audit: `[221, 216, 199, 201, 202]` ms;
- standalone median: 202 ms; five-sample p95 proxy: 221 ms;
- the heavier umbrella certification immediately after Chromium + upstream interop produced a noisier `[259, 395, 256, 213, 216]` ms sample (median 256 ms, p95 proxy 395 ms), so these timings should be treated as machine/load-sensitive regression evidence rather than SLA numbers;
- pre-timing-fix inactive-tab diagnostic: ~6005 ms.

### 16.3 Representative record heap telemetry

The real MV3 harness samples fixture-renderer `performance.memory` during the 15-second recording with Chromium precise-memory telemetry enabled.

One latest representative run:

```text
used JS heap before:       921,010 B
observed peak:           6,154,850 B
observed peak delta:     5,233,844 B
samples:                         16
```

This is a **regression signal**, not a universal maximum-memory guarantee. Attaching CDP to the service worker for heap sampling is intentionally avoided because a debugger attachment could keep the worker alive and invalidate the MV3 lifetime proof.

Hard resource safety comes from protocol bounds, SnapEye's frame/pixel ceilings, and OpenCode host byte/artifact budgets.

### 16.4 Post-implementation performance audit

After the correctness/certification campaign, the completed implementation received a separate code-path audit focused on eliminating avoidable work rather than weakening barriers. The changes retained after measurement were:

1. **Single-pass committed-baseline verification during browser diffs.** The host previously streamed a committed PNG once to SHA-256 it and then a second time to send it to SnapEye. The browser transport now hashes the exact sequential chunks already being sent and makes `baseline_read_close` the integrity barrier before `RemoteVisualArtifactStore` can return the Blob. Ordinary direct store reads retain eager verification. A synthetic 32 MiB warm-cache workload moved from a 32.41 ms eager-verification median to 27.11 ms single-pass median (~1.20x), while removing one complete O(file-size) disk scan by construction.
2. **Retention is off the terminal-result critical path.** `result.json` remains the authoritative terminal boundary. Pruning now starts after an event-loop turn, coalesces bursts behind one maintenance task, and exposes `flushMaintenance()` for deterministic shutdown/tests. A regression test deliberately blocks pruning and proves `commitResult()` still publishes/returns the terminal result.
3. **Bounded history fanout.** Baseline/run history scanning uses an eight-worker pool rather than serialized entry I/O or unbounded `Promise.all`. The same synthetic 80-baseline workload improved from 68.69 ms to 45.36 ms warm median (~34%) on the certification machine.
4. **Native typed-array base64 fast path in Chrome.** Modern runtimes use `Uint8Array.toBase64()` / `Uint8Array.fromBase64()` when available, retaining the prior bounded blockwise `btoa`/`atob` implementation as a compatibility fallback. A Bun proxy microbenchmark over 100 x 384 KiB encodes measured 7.74 ms native vs 699.18 ms fallback; the real 1/8/32 MiB extension transport matrix remains green (564 assertions) and has measured around 405 ms in a clean post-change run.
5. **Operation-aware Visual Inspector I/O.** Record review no longer reads/clones baseline PNG or metadata that it never renders; capture review loads the baseline image only; diff review retains the complete baseline pair because exact reviewed-byte approval requires both digests.
6. **O(1) post-approval summary.** Exact human approval now inspects only the baseline it just committed instead of scanning/sorting up to 200 baselines to rediscover it.
7. **Per-tab visual admission parity.** Chrome now matches the Electron lane's one-active-visual-operation-per-tab rule, rejecting duplicate expensive work before target resolution/runtime execution while preserving certified concurrency across different tabs.

The audit explicitly left several mechanisms unchanged because their cost buys important correctness: sequential artifact acknowledgements/backpressure, per-operation SnapEye attach/destroy with capability-scoped stores, one readiness probe per Chrome visual operation, and the existing bounded adaptive GIF palette/cache. No optimization was accepted solely from source inspection; each retained change has either a targeted correctness regression test, a measured workload, or both.

---

## 17. Real-browser fidelity matrix

The Chrome fidelity harness runs the actual shared runtime in both MAIN and extension-style ISOLATED execution worlds where applicable.

| Case | Certified behavior |
| --- | --- |
| MAIN vs ISOLATED static capture | exact PNG bytes equal on controlled fixture |
| Reverse ISOLATED baseline -> MAIN diff | unchanged |
| Ordinary DOM/style mutation | detected |
| Infinite CSS animation | stable under capture/diff |
| Geometry-changing cold hydration | settles and remains unchanged |
| Paint-only hydration | deterministic with explicit readiness selector |
| CSSOM-only rule mutation | detected |
| Redacted block/value changes | suppressed |
| Adjacent unredacted change | detected |
| Hostile MAIN `snapeye`/OpenCode globals | isolated runtime unaffected |
| MAIN prototype monkey-patching | isolated runtime unaffected in tested paths |
| High-DPR host | deterministic SnapEye DPR/scale=1 contract |
| Shadow DOM | included in controlled cross-world proof |
| SVG | included; large SVG separately stressed |
| reflected form state | included |
| transform + shadow/overflow bleed | included |
| static Canvas | repeated capture unchanged; pixel mutation detected |
| static WebGL with preserved buffer | repeated capture unchanged; mutation detected |
| animated Canvas/WebGL | motion certified through `visual_record` |
| same-origin iframe | repeated capture unchanged; interior mutation detected |
| cross-origin iframe | stable opaque surface; no OpenCode DOM introspection |
| late image | deterministic with explicit readiness |
| late FontFace | deterministic with explicit readiness |
| 4,000-node DOM | unchanged after capture/diff; bounded capture time measured |
| 2,200-node SVG | unchanged after capture/diff; bounded capture time measured |
| restrictive page CSP | production extension capture/record path works |
| record GIF | works |
| record video | works (`recording.mp4` on current Windows runtime) |
| 15-second record | works through real MV3 service worker |
| 15-second abort | prompt; no terminal result |

Current controlled MAIN/ISOLATED baseline hash:

```text
10748a7f7a5bf44ea1dff2d7c35eb0eb373354853fc6e9a05ee2b1350046dbed
```

Exact cross-platform/Chromium-major PNG identity is **not** a product contract. Environment fingerprinting exists precisely because rendering environments can legitimately differ.

---

## 18. Critical proof gates — final status

### Gate A — Chrome isolated-world fidelity: **PASS**

Proven on real Chrome with cross-world byte identity plus the expanded fixture matrix above.

### Gate B — Electron sandboxed-preload fidelity: **PASS**

Real production preload/runtime verifies:

```text
sandbox=true
contextIsolation=true
nodeIntegration=false
```

Capture/diff/redaction/record/video/abort/upstream interoperability all work without weakening the guest security model.

### Gate C — native artifact streaming: **PASS**

1 MiB, 8 MiB, and 32 MiB baselines round-trip through bounded extension wire chunks with offset/order/size checks. Native-port tests also cover disconnect/reconnect and out-of-order correlation.

### Gate D — upstream interoperability: **PASS**

Both directions are proven with SnapEye 0.4.0:

1. OpenCode baseline -> upstream SnapEye diff: unchanged.
2. Upstream SnapEye baseline -> OpenCode diff: unchanged.

Latest controlled interop baseline hash in both directions:

```text
7263872850a6da6e971d3bf4fbe10a5fd111777348913cbea9394a1626ab19d2
```

OpenCode additive metadata does not break upstream readers.

---

## 19. Real MV3 lifetime/lifecycle certification

The verifier loads an ephemeral unpacked copy of the production extension in Playwright Chromium. The production `sw.bundle.js` and visual bundle execute normally; only the native host is replaced by a test-only in-memory transport so system native-host registration is not modified.

The gate currently proves in one run:

- same service-worker boot ID before/after 15-second record;
- strict page CSP;
- actual 15-second record and >=10 frames;
- artifact RPC completion + exactly one terminal result;
- heavy runtime injected exactly once per document;
- warm operation does not reinject;
- trusted-input cancellation returns `BrowserControlInterrupted`;
- navigation returns `BrowserControlInterrupted`;
- tab close/context disappearance returns `BrowserControlInterrupted`;
- interrupted runs publish no terminal result;
- navigation invalidates the old document runtime and causes one cold injection in the new document;
- two independent inactive tabs capture successfully through one worker/native channel;
- five warm concurrent independent diffs remain unchanged;
- a production `snapshot` ref can target `visual_capture` successfully;
- replacing the snapshot invalidates the old ref and returns canonical `BrowserStaleRefError`;
- stale-ref failure publishes no terminal visual result and does not strand an active visual request;
- a fresh replacement ref can immediately run an unchanged `visual_diff` without reinjecting the heavy runtime;
- worker does not restart across lifecycle/concurrency probes.

Latest warm concurrent samples:

```text
[210, 206, 214, 203, 195] ms
median 206 ms
p95 sample 214 ms
```

---

## 20. Upstream compatibility and upgrade policy

The visual engine versions are exact-pinned because a visual renderer upgrade can legitimately change pixels and therefore baseline identity.

Any future SnapEye or SnapDOM upgrade should be treated as a baseline-affecting dependency change and must rerun at minimum:

```text
browser-visual typecheck
real Chromium fidelity
upstream interoperability
real MV3 lifetime/lifecycle
Electron sandbox verifier
1/8/32 MiB transport stress
bundle budgets
protocol/core/Desktop focused suites
```

Do not deep-import SnapEye private server/filesystem modules. If upstream later exposes a supported reusable filesystem store, it can be evaluated behind the existing host-store test contract.

---

## 21. Test/certification ledger

Latest focused results in this worktree:

```text
Protocol browser contract                         27/27
Core BrowserHostBroker                            58/58
Desktop focused browser/visual integration        72/72
App visual client + preview lifecycle              4/4
Chrome extension focused                           20/20
Artifact transport 1/8/32 MiB                     PASS / 564 assertions
browser-visual package typecheck                  PASS
protocol package typecheck                        PASS
real Chrome fidelity                              PASS
real MV3 lifetime/lifecycle/concurrency           PASS
real Electron sandbox verifier                    PASS
upstream SnapEye 0.4 interoperability             PASS
shipping bundle budgets                           PASS
production Electron build                         PASS
git diff --check                                  PASS
```

The repository-root `typecheck changed` command is **not** used as the authority for this feature. The root tsconfig is server-oriented and currently tries to compile Solid/DOM app sources without their package DOM/alias context, producing thousands of unrelated diagnostics (`react/jsx-runtime`, missing DOM globals, `@/` aliases, etc.). Full Desktop/OpenCode/Core package checks also currently surface unrelated pre-existing project debt (app React/JSX environment issues, SPAD/control-plane diagnostics, and ChunkDB/database-test type drift). The browser-visual and protocol package checks pass; focused tests plus the actual production Electron/Vite build are the feature-local compilation/runtime authorities here.

---

## 22. Reproducible verification commands

Shared/browser certification:

```bash
cd packages/browser-visual
bun run verify:all
```

`verify:all` performs browser-visual package typecheck, hermetic Chrome generated-bundle freshness verification, real Chromium fidelity, upstream interoperability, real MV3 certification, and fresh shipping bundle-budget verification. The bundle gate intentionally fails if Desktop renderer artifacts are stale.

Desktop real-browser verification:

```bash
cd packages/desktop
bun run verify:visual-webview
```

Representative focused suites:

```bash
cd packages/protocol
bun test test/browser.test.ts
bun run typecheck

cd packages/core
bun test test/browser/host-broker.test.ts

cd packages/desktop
bun test src/main/browser/visual/*.test.ts \
  src/main/browser/contracts.test.ts \
  src/main/browser/extension-bridge/integration-e2e.test.ts \
  src/main/browser/host.test.ts \
  src/main/browser/operations.test.ts \
  src/main/browser/engine-annotation.e2e.test.ts
bun test src/main/browser/visual/transport-stress.test.ts

cd extensions/chrome
bun test host/native-host.test.ts src/background/native-port.test.ts
```

Production build:

```bash
cd packages/desktop
bun run build
```

---

## 23. Phase completion

| Phase | Status | Evidence |
| --- | --- | --- |
| P0 architecture/proof foundations | **complete** | dispatch context, capabilities, store, two real browser runtimes, streaming gates |
| P1 capture + diff | **complete** | both lanes + real fidelity + upstream interop |
| P2 targeting/privacy/artifact UX | **complete** | element targets, real Chrome refs, redaction digest, history/artifact/preview, retention |
| P3 record | **complete** | filmstrip/GIF/video, 15s MV3, cancellation/lifecycle, resource bounds |
| P4 Desktop visual workflow | **implemented** | lazy inspector, history, triptych/review, recording preview, exact human approval |

P4 is intentionally an additive workbench rather than a second persistence implementation; it calls the same coordinator/store paths as tools.

---

## 24. Explicit policy boundaries and non-goals

The following are deliberate boundaries, not unfinished plumbing:

1. **Cross-origin iframe DOM is opaque.** OpenCode observes the rendered iframe surface but does not pierce origin boundaries for SnapEye DOM introspection.
2. **Paint-only async work needs readiness.** Geometry settle cannot infer arbitrary application semantic readiness; use `waitFor`.
3. **Imperative GPU/canvas motion belongs in record.** Capture/diff stabilization controls CSS animation/transition semantics, not arbitrary application render loops.
4. **Different rendering environments can require different baselines.** Environment fingerprint mismatch fails closed for known OpenCode metadata.
5. **Video preview is bounded/open-only.** Do not inject large video data into model context or casually clone it into renderer memory.
6. **No arbitrary SnapDOM plugin/function injection from model input.** Redaction and model-facing options stay declarative/bounded.
7. **No automatic recapture to make a failed diff pass.** Baselines are explicit reference state.
8. **No visual artifacts in normal BrokerResponse.** Keep the semantic control plane small.
9. **No weakening of Electron sandbox or Chrome isolated-world model for SnapEye.**
10. **No claim of cross-platform bit-identical PNGs.** Compatibility metadata exists because browser/OS/font engines differ.

---

## 25. Security review summary

The implementation preserves these trust boundaries:

- project root comes only from authenticated broker context;
- browser pages never receive Desktop bearer token or arbitrary filesystem APIs;
- capability tokens are operation/request/project/run scoped;
- fixed artifact names and paths;
- no path traversal/symlink/junction escapes;
- bounded native frames and artifact sizes;
- terminal result is immutable/single-assignment;
- redaction identity is baseline identity;
- strict CSP does not force MAIN-world execution;
- Chrome visual RPC validates extension sender/tab provenance;
- renderer preview revalidates descriptors through the host store;
- human takeover invalidates deterministic observation rather than silently publishing questionable state;
- interrupted operations cannot publish a later terminal result.

---

## 26. Merge/closeout checklist

Before this branch is merged or split into reviewable commits/PRs:

- [x] exact-pin SnapEye/SnapDOM;
- [x] preserve dispatch provenance;
- [x] two browser lanes use the same shared runtime;
- [x] lazy runtime in both lanes;
- [x] strict host persistence + capability scope;
- [x] capture/diff/record/history/artifact tools;
- [x] declarative redaction + policy digest;
- [x] real OpenCode element targeting in both lanes;
- [x] real Chrome snapshot/ref semantics;
- [x] real shipping-MV3 current/stale snapshot-ref targeting + cleanup proof;
- [x] human/lifecycle cancellation in both lanes;
- [x] real MV3 15-second lifetime proof;
- [x] background-tab timing-throttle fix + multi-sample proof;
- [x] filmstrip/GIF/video proof;
- [x] licensing-safe adaptive GIF encoder + shipping-bundle provenance guard;
- [x] Chromium `ImageDecoder` decodes every generated GIF frame;
- [x] canonical third-party notice in Chrome + packaged Desktop resources;
- [x] packaged Electron `app.asar` contains no `gifenc`/PnnQuant source tree;
- [x] 1/8/32 MiB artifact streaming proof;
- [x] upstream interoperability both directions;
- [x] lazy Desktop Visual Inspector + exact approval;
- [x] fresh production bundle budgets;
- [x] hermetic byte-for-byte Chrome generated-bundle freshness gate;
- [x] production Electron build;
- [x] expanded hostile/content fidelity matrix;
- [x] remove stale verifier artifacts;
- [x] `git diff --check` clean;
- [x] decide review/commit structure;
- [ ] commit only after final human review of the full feature diff.

The remaining unchecked item is a source-control/human-review decision, not missing SnapEye implementation.

---

## 27. Recommended review / commit split

The implementation spans enough trust boundaries that a single 90-file commit would be unnecessarily difficult to review. The recommended source-control split is dependency ordered and keeps generated artifacts adjacent to the source that produces them:

1. **`feat(browser): add SnapEye protocol and host authority`**
   - browser protocol/capability schemas and broker feature gating;
   - dispatch-context provenance;
   - Desktop visual protocol/path safety/store/coordinator/RPC;
   - shared `@opencode-ai/browser-visual` runtime, redaction, bounded adaptive GIF encoder;
   - exact dependencies/lockfile/release-age exception and canonical third-party notices.

2. **`feat(browser): integrate SnapEye with webview and Chrome lanes`**
   - Electron isolated-world runtime/controller/preload bridge;
   - Chrome visual runtime loader, lifecycle tracking, snapshot refs, conditional CDP targeting;
   - native artifact RPC transport;
   - extension build pipeline and generated `sw.bundle.js` / `content.js` / `visual.bundle.js` / notice copy;
   - lane-focused tests.

3. **`feat(browser): expose visual tools and review workflow`**
   - `visual_capture`, `visual_diff`, `visual_record`, `visual_history`, `visual_artifact` tools;
   - `browser.visual` permission and browser gateway delegation;
   - trusted renderer history/preview/approval IPC;
   - lazy Visual Inspector, i18n, exact reviewed-byte approval transaction;
   - renderer/engine tests.

4. **`test(browser): certify SnapEye integration`**
   - real Chromium fidelity harness;
   - real MV3 lifetime/concurrency/ref/lifecycle harness;
   - Electron sandbox verifier;
   - upstream interoperability verifier;
   - 1/8/32 MiB transport stress;
   - bundle/provenance budgets and generated-bundle freshness checks;
   - this implementation/certification ledger and verifier scratch ignore rule.

If preserving a green build at every intermediate commit proves awkward during staging because shared type mirrors cross commit boundaries, prefer collapsing commits 1+2 rather than moving files out of their conceptual owners. The final history should optimize reviewability without creating knowingly broken intermediate commits.
