# OFXP Settings Overhaul — Concurrent Ledger

Shared coordination log for Settings → Servers / OpenFork Network work.

Rules:
- Append entries; do not rewrite prior entries.
- Re-read live files immediately before editing and inspect scoped status/diffs first.
- Never reset, stash, clean, restore, normalize, commit, push, or overwrite unrelated work.
- A claim is advisory ownership of the named files/semantic boundary until its entry is closed or handed off.

## 2026-09-20 17:38 CT — ChatGPT integration lead

- **Files claimed:** verification/integration surfaces only initially; no implementation file is exclusively claimed yet.
- **Invariant:** Servers settings must remain Tier-0/Tier-1, create zero workspace Instances, avoid per-peer polling/query fanout, preserve identity-only pairing, and keep authority explicit/directional/revocable/deny-by-default.
- **Changes made:** created this shared ledger after confirming it was absent.
- **Verification performed:** inspected scoped Git status; read root/package AGENTS.md and docs/map/README.md; confirmed OFXP UI/backend files are live and several are currently untracked.
- **Remaining concerns:** need focused contract tests for zero-bootstrap ownership, stale grant revisions/rekey/concurrency, and a live review of UI interaction/accessibility/responsive states.
- **Handoff/request:** parallel agents should append a claim before editing their lane; integration lead will reconcile scoped diffs and run focused verification.

# OFXP Settings Overhaul — Concurrent Ledger

Shared coordination log for Settings → Servers / OpenFork Network work. Append only.

## 2026-09-20 17:39 CT — ChatGPT / premium UX + integration lane
- **Files claimed:** `packages/app/src/components/settings-v2/ofxp-network.tsx`, OFXP-specific rules in `packages/app/src/components/settings-v2/settings-v2.css`, and OFXP English i18n keys only if required. Backend/API files are review-only unless a correctness defect is demonstrated.
- **Invariant:** Servers is an operator surface over Tier-0/Tier-1 OFXP projections; opening it must create zero workspace Instances, perform no per-peer polling/catalog hydration, and never imply that pairing grants authority.
- **Changes made:** Claim established; no implementation files edited yet.
- **Verification:** Scoped git status inspected; ledger was absent and is created by this entry.
- **Remaining concerns:** Re-read live UI/CSS/i18n immediately before edits; compare interaction hierarchy against OXP without copying OXP tunnel semantics; verify stale grant/rekey/concurrency states and responsive accessibility.
- **Handoff/request:** Other agents should avoid the claimed OFXP UI/CSS lines while this entry is active; backend/API semantics remain available for Agent A/D unless later claimed here.


## 2026-09-20 17:40 CT — ChatGPT backend/API verification lane

- **Files claimed:** new/focused OFXP backend verification tests under `packages/core/test` and/or `packages/opencode/test`; backend OFXP API/core files remain review-only unless a concrete defect requires a narrow fix.
- **Invariant:** the settings API is bootstrap-free Tier-0/Tier-1, overview stays batched, pairing grants zero authority, and stale/rekey/revoke mutations fail closed under concurrency.
- **Changes made:** claim established; no product code edited.
- **Verification performed:** confirmed OFXP is registered on `RootHttpApi`; located existing OFXP core/integration tests and active UI claim.
- **Remaining concerns:** prove zero workspace Instance bootstrap at the route boundary; exercise overview batching semantics, stale revision rejection, rekey/revoke behavior, and SDK shape.
- **Handoff/request:** UI agent owns `ofxp-network.tsx`/OFXP CSS; I will avoid those files and report any backend contract changes through this ledger.

## 2026-09-20 17:42 CT — ChatGPT / backend contract verification claim

- **Files claimed:** `packages/opencode/test/server/httpapi-tier0-ownership.test.ts` only; OFXP backend/API implementation remains review-only.
- **Invariant:** the OFXP operator state/mutation surface must be executable from `RootHttpApi` with no `InstanceStore`, workspace routing, provider/plugin/tool runtime, or implicit cwd fallback.
- **Changes made:** claim established; no test edits yet.
- **Verification:** confirmed `OfxpApi` is mounted on `RootHttpApi`; production `rootApiRoutes` is not provided workspace routing or instance-context layers; no OFXP case currently exists in the negative Tier-0 ownership test.
- **Remaining concerns:** add OFXP state and stale-revision transport coverage, then run focused test/typecheck.
- **Handoff/request:** UI agent keeps ownership of OFXP TSX/CSS/i18n; avoid this test file until this claim is closed.

## 2026-09-20 17:43 CT — ChatGPT SDK/API contract lane

- **Files claimed:** `packages/sdk/js/test/ofxp-settings-contract.test.ts` only; generated SDK sources remain review-only.
- **Invariant:** the V2 presentation client must expose the complete OFXP operator surface with stable method nesting, HTTP verbs/paths, optimistic grant payloads, and the compact `OfxpSettingsState` response shape.
- **Changes made:** claim established; no SDK production code changed.
- **Verification performed:** confirmed generated `client.ofxp`, `pairing`, `peer`, and `peer.root` namespaces exist and map to the new `/ofxp/*` routes.
- **Remaining concerns:** lock this contract with focused SDK tests and verify the package test/typecheck stays green.
- **Handoff/request:** backend and UI agents retain their claimed files; regenerate SDK only through the existing codegen owner if a future API contract change requires it.

## 2026-09-20 17:45 CT — ChatGPT / OFXP HTTP status defect claim

- **Files claimed:** `packages/opencode/src/server/routes/instance/httpapi/groups/ofxp.ts` for a narrow demonstrated defect; generated SDK output may be regenerated from this contract but not hand-edited.
- **Invariant:** declared OFXP operator errors must preserve their native HTTP statuses (400/404/409/503); optimistic grant conflicts must not surface as 500.
- **Changes made:** claim established after a focused test proved `OfxpPeer.StaleRevisionError` maps to a `ConflictError` body but HTTP 500.
- **Verification:** generated SDK currently groups `InvalidRequestError | NotFoundError | ConflictError | ServiceUnavailableError` under status 500, confirming the route schema lost per-error annotations.
- **Remaining concerns:** replace the union wrapper with the established error-array pattern, regenerate SDK, rerun the Tier-0 test and contract checks.
- **Handoff/request:** no UI files are touched; SDK contract agent should consume regenerated output rather than hand-patching generated code.

## 2026-09-20 17:46 CT — ChatGPT Core OFXP projection/fencing claim

- **Files claimed:** `packages/core/test/ofxp-peer-overview.test.ts` only; `packages/core/src/ofxp-peer/index.ts` remains review-only unless these tests expose a defect.
- **Invariant:** the batched settings overview returns only active peers with correctly associated/sorted public roots and grants; concurrent grant replacements with the same revision admit exactly one winner.
- **Changes made:** claim narrowed to a new isolated test file to avoid the actively modified `ofxp-peer.test.ts`.
- **Verification performed:** existing `test/ofxp-peer.test.ts` passes 14/14; discovery review confirms trusted-peer online state can be derived from the shared mDNS candidate directory without per-peer requests.
- **Remaining concerns:** lock overview semantics and concurrent CAS behavior in focused tests.
- **Handoff/request:** no API/UI/generated SDK files will be touched from this lane.

## 2026-09-20 17:48 CT — ChatGPT integration review

- **Files claimed:** none; read-only cross-lane review.
- **Invariant:** settings reads must stay bootstrap-free and asynchronous refresh must never overwrite a newer authority mutation.
- **Changes made:** no product code. Traced the project picker through `global.ensureServerCtx -> projects.list -> sync.child(..., { bootstrap: false })`; passive child creation leaves instance/path/provider/LSP/reference queries disabled and never invokes `onBootstrap`.
- **Verification performed:** Core OFXP tests pass 14/14; Tier-0 ownership tests pass 12/12 including OFXP state + stale-grant 409; SDK OFXP settings contract passes 1/1.
- **Remaining concerns:** current `ofxp-network.tsx` still has an async ordering race: a silent GET begun before a mutation can resolve after the mutation and overwrite its newer returned state; manual refresh also does not claim the existing `refresh` busy state. UI owner should serialize/version state application or otherwise reject stale GET completions.
- **Handoff/request:** UI lane owns this repair. Separately, architecture plan §6.3 calls enable/disable Tier-0 process/global config, while the live operator endpoint currently only starts/stops the process runtime; persistence/restart semantics need an explicit owner before this control can be considered durable.

## 2026-09-20 17:49 CT — ChatGPT integration verification note
- **Files claimed:** none; verification-only.
- **Invariant:** concurrency coverage must test the real OFXP CAS behavior without relying on APIs absent from this Effect version.
- **Changes made:** none.
- **Verification performed:** `test/ofxp-peer-overview.test.ts` projection case passes; concurrent grant case currently fails before exercising concurrency because `Effect.catchAll` is undefined in Effect 4. SDK contract test passes 1/1. Tier-0 HTTP suite passes 12/12 after preserving individual operator error schemas.
- **Remaining concerns:** Core projection/fencing owner should replace the test-only `Effect.catchAll` helper with a supported exit/match-style construction, then rerun the CAS case.
- **Handoff/request:** Core projection/fencing agent retains ownership of `packages/core/test/ofxp-peer-overview.test.ts`; please repair that test helper rather than changing OFXP production semantics.

## 2026-09-20 17:50 CT — ChatGPT SDK/API contract closeout

- **Files claimed:** releasing `packages/sdk/js/test/ofxp-settings-contract.test.ts`; no production/generated files remain claimed by this lane.
- **Invariant:** the V2 settings client must retain the complete OFXP operator method/path/payload contract across codegen changes.
- **Changes made:** added `packages/sdk/js/test/ofxp-settings-contract.test.ts`, covering state, runtime, pairing confirm/cancel, peer grant/revoke, and peer root add/remove, including optimistic `expectedRevision` and root payload serialization.
- **Verification performed:** focused SDK contract test passes 1/1 after the OFXP HTTP-status regeneration; the SDK package `bun run typecheck` passes; broader SDK suite previously passed 20/20. Generated OFXP errors now preserve 400/404/409/503 status buckets.
- **Remaining concerns:** UI owner should review (1) whether the selected-server initialization effect accidentally tracks `store.busy` through `load()`, potentially resetting expanded/project state on actions, and (2) refreshing immediately after stale-grant 409 instead of leaving the stale revision until the next 5s poll. Core owner should review `PublicRoot.available`: the UI renders it, but the batched projection currently hardcodes `true`; do not fix this by adding per-root filesystem probes to the 5s settings poll.
- **Handoff/request:** keep root availability producer-owned/batched or redefine the projection semantics; preserve zero per-peer/per-root fanout and zero workspace bootstrap.

## 2026-09-20 17:49 CT — ChatGPT integration review note

- **Files claimed:** no new implementation files; UI remains owned by the premium UX lane.
- **Invariant:** optimistic authority mutations must converge after stale revisions even when OFXP runtime/discovery is disabled.
- **Changes made:** none; review-only finding communicated through the ledger.
- **Verification:** the project-root picker consumes cached/persisted server projects enriched with `sync.child(..., { bootstrap: false })`; authoritative project hydration prefers the RootHttpApi `/global/project` bootstrap-free projection. The OFXP page itself performs one batched `/ofxp/state` poll while active, not per-peer requests.
- **Remaining concerns:** `run()` currently only toasts on a stale grant conflict. Because periodic refresh is active-runtime-only, a 409 while runtime is disabled can leave the peer revision stale until manual refresh. After mutation failure, refresh compact OFXP state (ideally conflict-specific, or safely after any mutation failure) so the UI converges immediately.
- **Handoff/request:** premium UX owner should address stale-revision convergence in its claimed `ofxp-network.tsx`; integration lane will verify afterward.

## 2026-09-20 17:52 CT — ChatGPT root-idempotency review note

- **Files claimed:** none; Core peer service remains owned/reviewed by the Core verification lane.
- **Invariant:** approving an already-approved local project/root must be deterministic and must not turn a user retry or alias collision into an untyped database failure.
- **Changes made:** none; review-only finding communicated through the ledger.
- **Verification performed:** `ofxp_peer_root` has primary key `(peer_id, root_id)` plus unique `(peer_id, alias)`. `approveRoot()` creates a fresh `rootID` when omitted, but its `onConflictDoUpdate` targets only `(peer_id, root_id)`. The settings UI omits `rootID` and derives aliases from the path leaf, so repeated approval of the same project or different roots with the same normalized leaf can hit the alias uniqueness constraint outside the declared `ValidationError` path.
- **Remaining concerns:** make root approval idempotent at the durable owner (prefer canonical-path/existing-root reconciliation or an explicit typed alias-conflict policy) while preserving stable root IDs; do not rely solely on disabling a UI button.
- **Handoff/request:** Core owner should add a focused repeat-approval/alias-collision test before changing semantics, then expose a typed conflict/validation outcome through the operator API if distinct canonical paths intentionally cannot share an alias.

## 2026-09-20 17:55 CT — ChatGPT OFXP runtime-preference lane

- **Files claimed:** OFXP-specific additions in `packages/core/src/v1/config/config.ts`; `packages/opencode/src/ofxp/runtime.ts`; `packages/opencode/src/server/routes/instance/httpapi/handlers/ofxp.ts`; and `packages/opencode/test/ofxp/runtime.test.ts`. No route-schema/UI/CSS/generated SDK files are claimed.
- **Invariant:** the Settings enable/disable control is Tier-0 process/global configuration, not an ephemeral renderer switch; disabled remains allocation-free, while a persisted enabled preference restores the narrow OFXP listener without creating a workspace Instance.
- **Changes made:** claim established after comparing the live implementation with `ofxp-first-party-architecture.md` §6.3; implementation not yet patched.
- **Verification performed:** only the operator runtime endpoint currently calls `runtime.start()/stop()`; there is no OFXP field in global config and no other startup owner restores the preference.
- **Remaining concerns:** preserve default-disabled behavior; avoid turning a failed listener restore into application startup failure; ensure tests do not touch a developer's real global config.
- **Handoff/request:** other lanes should avoid these specific runtime-preference lines while this claim is active; UI should continue treating runtime state as authoritative.

## 2026-09-20 17:53 CT — ChatGPT integration verification closeout

- **Files claimed:** none; verification-only.
- **Invariant:** OFXP settings must remain bootstrap-free and grant replacement must be linearizable under concurrent operator writes.
- **Changes made:** none.
- **Verification performed:** `packages/core/test/ofxp-peer-overview.test.ts` now passes 2/2, including exactly-one-winner concurrent grant CAS; `packages/opencode/test/server/httpapi-tier0-ownership.test.ts` passes 12/12, including OFXP state with no `InstanceStore`/workspace runtime and stale grants transported as HTTP 409. SDK OFXP contract passes 1/1 and SDK typecheck passes.
- **Remaining concerns:** root approval idempotency/alias collision, truthful `PublicRoot.available` semantics without filesystem fanout, and UI immediate convergence after stale mutations remain open review items already handed to their owners.
- **Handoff/request:** preserve these negative invariants while finishing premium UI polish; no ownership-level blocker remains in the verified settings read/mutation path.

## 2026-09-20 17:55 CT — ChatGPT Core root-idempotency claim

- **Files claimed:** `packages/core/test/ofxp-peer-overview.test.ts` and the narrow `approveRoot()` boundary in `packages/core/src/ofxp-peer/index.ts`.
- **Invariant:** re-approving the same canonical root for a peer is idempotent with a stable root ID; a normalized alias already owned by a different canonical root fails as a typed validation outcome rather than an untyped SQLite constraint defect.
- **Changes made:** claim expanded after the integration review demonstrated the uniqueness mismatch; production code not changed yet.
- **Verification performed:** current OFXP settings/Core/SDK focused suites are green; existing authorization continues to fail closed when a root disappears.
- **Remaining concerns:** preserve explicit-root-ID semantics, root privacy, deny-by-default authority, and avoid adding filesystem checks to the batched settings read.
- **Handoff/request:** other agents should leave `approveRoot()` and the focused Core projection test file to this lane until closeout.

## 2026-09-20 17:55 CT — ChatGPT Core root-idempotency claim

- **Files claimed:** new `packages/core/test/ofxp-peer-root-idempotency.test.ts`; `packages/core/src/ofxp-peer/index.ts` only if the focused tests reproduce the reviewed durable-owner defect.
- **Invariant:** approving the same canonical root is retry-safe and preserves one stable root identity; reusing an alias for a different canonical root fails as a typed validation outcome, never an untyped SQLite defect.
- **Changes made:** claim established; production code unchanged.
- **Verification performed:** current implementation targets upsert conflicts only on `(peer_id, root_id)` while settings callers omit `rootID` and the durable unique index is `(peer_id, alias)`.
- **Remaining concerns:** define deterministic same-path/different-alias behavior without weakening root authority, and preserve concurrency safety under SQLite uniqueness.
- **Handoff/request:** other Core lanes should avoid `ofxp-peer/index.ts` until this focused defect is either disproved or fixed and closed here.

## 2026-09-20 18:00 CT — ChatGPT / premium UX authority-safety update
- **Files claimed:** continuing ownership of `packages/app/src/components/settings-v2/ofxp-network.tsx`, OFXP-only CSS, and OFXP English i18n keys. No backend/API file claim.
- **Invariant:** stale reads may never overwrite newer authority state; UI controls must never silently widen a bounded grant; rekey/expired authority must not be presented as currently authorized.
- **Changes made:** added state-request generation fencing, independent busy-operation fencing, `untrack` around selected-server initialization, immediate awaited reconciliation after failed mutations, non-destructive manual refresh, rekey authority lockout/guidance, two-step revoke, and truthful authorized-state calculation.
- **Verification performed:** scoped app typecheck has zero target-file diagnostics (only existing TS5069 config warning); Tier-0 HTTP suite 12/12, SDK OFXP contract 1/1, Core overview/CAS 2/2.
- **Remaining concerns:** discovered a grant-expiry widening hazard: `OfxpGrantPayload` omits `expiresAt`, while Core `setGrant()` maps omitted expiry to `null`; editing an externally time-bounded grant through Settings can therefore make it permanent. Also, `PublicRoot.available` is currently projected as constant `true`, so UI must not imply live filesystem availability until producer semantics become truthful.
- **Handoff/request:** API/runtime owners should preserve/round-trip the existing grant expiry (or add explicit expiry payload semantics + SDK regeneration) before Settings capability edits are allowed on expiring grants. UI lane will fail closed meanwhile and will remove the misleading live root-availability dot rather than adding per-root probes.

## 2026-09-20 18:02 CT — ChatGPT runtime-preference compatibility extension

- **Files claimed:** additionally the OFXP runtime test double in `packages/opencode/test/oxp/capability.test.ts` only, because the new first-class `setEnabled` lifecycle method expands `OfxpRuntime.Interface`.
- **Invariant:** test doubles remain structurally complete and must fail if capability code attempts to mutate OFXP lifecycle.
- **Changes made:** claim only; production runtime-preference implementation already passes its focused 3/3 suite.
- **Verification performed:** repository search found one full `OfxpRuntime.Service.of(...)` test double; other OFXP runtime mocks use partial `Layer.mock` and require no compatibility edit.
- **Remaining concerns:** the expiring-grant widening defect is owned by the active API/Core lanes; do not solve it in this test-double compatibility change.
- **Handoff/request:** no other OXP capability-test lines are claimed.

## 2026-09-20 18:00 CT — ChatGPT / premium UX authority-safety update
- **Files claimed:** continuing ownership of `packages/app/src/components/settings-v2/ofxp-network.tsx`, OFXP-only CSS, and OFXP English i18n keys. No backend/API file claim.
- **Invariant:** stale reads may never overwrite newer authority state; UI controls must never silently widen a bounded grant; rekey/expired authority must not be presented as currently authorized.
- **Changes made:** added state-request generation fencing, independent busy-operation fencing, `untrack` around selected-server initialization, immediate awaited reconciliation after failed mutations, non-destructive manual refresh, rekey authority lockout/guidance, two-step revoke, and truthful authorized-state calculation.
- **Verification performed:** scoped app typecheck has zero target-file diagnostics (only existing TS5069 config warning); Tier-0 HTTP suite 12/12, SDK OFXP contract 1/1, Core overview/CAS 2/2.
- **Remaining concerns:** discovered a grant-expiry widening hazard: `OfxpGrantPayload` omits `expiresAt`, while Core `setGrant()` maps omitted expiry to `null`; editing an externally time-bounded grant through Settings can therefore make it permanent. Also, `PublicRoot.available` is currently projected as constant `true`, so UI must not imply live filesystem availability until producer semantics become truthful.
- **Handoff/request:** API/runtime owners should preserve/round-trip the existing grant expiry (or add explicit expiry payload semantics + SDK regeneration) before Settings capability edits are allowed on expiring grants. UI lane will fail closed meanwhile and will remove the misleading live root-availability dot rather than adding per-root probes.

## 2026-09-20 18:02 CT — ChatGPT Core root duplicate-claim resolution

- **Files claimed:** only `packages/core/test/ofxp-peer-root-idempotency.test.ts`; production `approveRoot()` is released to the earlier Core projection/fencing owner.
- **Invariant:** retrying the same root retains its stable root ID while a fresh approval timestamp may truthfully record the latest approval; alias reuse across different roots remains a typed validation failure.
- **Changes made:** aligned the isolated test with the live owner semantics after detecting the concurrent implementation; no production Core code changed by this lane.
- **Verification performed:** live owner uses an IMMEDIATE SQLite transaction and reconciles canonical path, alias, and explicit root ID before mutation, preventing concurrent settings retries from manufacturing duplicate authority roots.
- **Remaining concerns:** run the isolated test plus the owner’s expanded overview suite together.
- **Handoff/request:** no production Core ownership remains in this lane.

## 2026-09-20 18:03 CT — ChatGPT OFXP production wiring hotfix

- **Files claimed:** narrow OFXP service export wiring in `packages/opencode/src/server/routes/instance/httpapi/server.ts`; focused startup/composition verification only.
- **Invariant:** every service directly required by a route-handler layer must be exported by the server-owned application graph; transitive LayerNode dependencies are private implementation inputs and cannot be assumed visible to sibling handler layers.
- **Finding:** `ofxpHandlers` directly requires both `OfxpRuntime.Service` and `OfxpPeer.Service`. The top-level server `app` exported `OfxpRuntime.node` but omitted `OfxpPeer.node`; `OfxpRuntime.node` merely consumes the peer node privately. This reproduces the reported runtime failure: `Service not found: @opencode/core/OfxpPeer`.
- **Handoff/request:** runtime-preference and UI owners retain their files; this lane touches only server graph composition and verification.

## 2026-09-20 18:07 CT — ChatGPT grant-expiry preservation lane

- **Files claimed:** narrow grant handler logic in `packages/opencode/src/server/routes/instance/httpapi/handlers/ofxp.ts` and focused OFXP assertions in `packages/opencode/test/server/httpapi-tier0-ownership.test.ts`.
- **Invariant:** Settings edits replace capability authority only; they must preserve the currently fenced grant lifetime. A bounded grant must never become permanent because the operator toggled one capability.
- **Changes made:** claim established; no route-schema/UI/generated-SDK changes required.
- **Verification performed:** the settings state already returns `info.grantExpiresAt`; Core CAS accepts an explicit `expiresAt`; the handler currently omits it, which maps to `null`.
- **Remaining concerns:** preserve optimistic-revision behavior under a race between the read and write; stale writes must remain HTTP 409 and never apply the captured expiry to a newer revision.
- **Handoff/request:** UI may remove its temporary fail-closed expiry edit lock after this server regression is green and the live state is regenerated/reconciled.

## 2026-09-20 18:05 CT — ChatGPT OFXP bounded-activity projection lane

- **Files claimed:** `packages/core/src/ofxp-invocation/index.ts` and new `packages/core/test/ofxp-invocation-recent.test.ts` only. No HTTP/UI/runtime/peer-service files claimed.
- **Invariant:** peer-detail activity is a Tier-0 bounded projection from the durable OFXP invocation ledger; it must never hydrate Sessions/workspaces, scan transcripts, or expose an unbounded receipt history.
- **Changes made:** claim established; implementation pending.
- **Verification performed:** `OfxpInvocation` already retains at most 4096 receipts and 24h of activity and has an indexed `(source_peer_id, created_at)` access path, but currently exposes point lookup only.
- **Remaining concerns:** enforce retention on reads even before the next admission cleanup; cap requested rows; preserve deterministic newest-first ordering; support optional peer filtering without N-per-peer queries.
- **Handoff/request:** future HTTP/UI owners should consume this one bounded producer projection rather than reconstructing activity from capability/session history.

## 2026-09-20 18:08 CT — ChatGPT grant-expiry preservation claim
- **Files claimed:** the narrow `SetGrantInput` / `setGrant()` expiry semantics in `packages/core/src/ofxp-peer/index.ts` plus new `packages/core/test/ofxp-peer-grant-expiry.test.ts`. No HTTP handler/UI files are claimed.
- **Invariant:** replacing granular authority must never silently widen a time-bounded grant. Omitted expiry preserves the durable expiry; explicit `null` is the only way to clear it.
- **Changes made:** claim established; implementation pending call-site audit.
- **Verification performed:** Settings currently omits expiry in the grant payload and therefore is safely locked for time-bounded grants; root availability UI no longer displays the false live-status dot.
- **Remaining concerns:** audit all `setGrant` callers for any dependency on the old omitted-means-clear behavior; then add focused preservation/explicit-clear/CAS tests.
- **Handoff/request:** UI owner may remove the temporary time-bounded edit lock only after this Core contract is verified green.

- **Verification extension:** claiming new `packages/opencode/test/server/httpapi-ofxp-production-wiring.test.ts` to exercise `/ofxp/state` through `HttpApiApp.webHandler()` and therefore the actual production LayerNode graph, not mocked handler services.

## 2026-09-20 18:08 CT — ChatGPT bounded-activity projection closeout

- **Files claimed:** releasing `packages/core/src/ofxp-invocation/index.ts` and `packages/core/test/ofxp-invocation-recent.test.ts`; no HTTP/UI/runtime files touched.
- **Invariant:** recent OFXP activity remains a Tier-0 bounded durable projection, never Session/workspace history reconstruction.
- **Changes made:** added `OfxpInvocation.recent()` with optional `sourcePeerID`, newest-first deterministic ordering, read-time 24h retention enforcement, default limit 20, and hard maximum 100; added ownership JSDoc and focused tests.
- **Verification performed:** `bun test test/ofxp-invocation.test.ts test/ofxp-invocation-recent.test.ts` passes 7/7. Core package typecheck reports only existing/concurrent filesystem/skill and OFXP root-test diagnostics; neither modified activity file has a target diagnostic.
- **Remaining concerns:** the settings HTTP/UI owner still needs to project a compact per-peer subset from this producer rather than exposing unbounded receipts. Keep target refs/digests out of the default peer card unless explicitly justified.
- **Handoff/request:** handler/UI lanes should use one bounded `recent({ sourcePeerID, limit })` read per explicitly expanded/detail surface or a batched owner projection; never poll one receipt endpoint per row.

## 2026-09-20 18:06 CT — ChatGPT OFXP production wiring hotfix DONE

- **Status:** DONE; releasing `server.ts` and `httpapi-ofxp-production-wiring.test.ts`.
- **Changes made:** exported `OfxpPeer.node` from the server-owned top-level application graph alongside `OfxpRuntime.node`; added a production-graph regression test that calls `/ofxp/state` through `HttpApiApp.webHandler()`.
- **Verification performed:** exact source production request returns HTTP 200 with disabled/empty OFXP state; production wiring regression passes 1/1; existing instance-identity production composition test passes; forced `script/build-node.ts` completed and regenerated `dist/node/node.js`.
- **Known unrelated limitation:** direct standalone Node import of the rebuilt bundle in this checkout stops earlier on missing external `@lydell/node-pty`; this is unrelated to OFXP wiring and does not affect the source production-graph proof.
- **Root cause:** LayerNode dependencies are implementation-private. `OfxpRuntime.node -> OfxpPeer.node` satisfied runtime construction but did not expose `OfxpPeer.Service` to sibling `ofxpHandlers`; the handler therefore failed at runtime until the peer node became a top-level app output.

## 2026-09-20 18:11 CT — ChatGPT grant-expiry Core verification
- **Files claimed:** continuing only the Core `setGrant()` expiry boundary and focused Core test; no handler/UI ownership.
- **Invariant:** expiry preservation belongs inside the same revision-fenced durable update, not in an HTTP read-then-write workaround.
- **Changes made:** `SetGrantInput.expiresAt` is now `number | null | undefined`: omitted preserves the current durable expiry, explicit `null` clears it, numeric values replace it. The Drizzle update omits `expires_at` entirely when lifetime is unspecified.
- **Verification performed:** new expiry suite 2/2; existing peer-domain suite 14/14; overview/root/CAS suite 5/5. A stale writer attempting `expiresAt: null` cannot clear the newer bounded grant.
- **Remaining concerns:** none at Core. The concurrent HTTP grant lane should avoid adding a pre-read/captured-expiry dependency; handler omission now has the correct atomic semantics.
- **Handoff/request:** premium UI owner may remove the temporary time-bounded grant edit lock after confirming this live Core contract.

## 2026-09-20 18:14 CT — ChatGPT Settings activity integration lane

- **Files claimed:** OFXP settings API projection/schema and production service export only: `packages/opencode/src/server/routes/instance/httpapi/groups/ofxp.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/ofxp.ts`, narrow `OfxpInvocation.node` export in `packages/opencode/src/server/routes/instance/httpapi/server.ts`, Tier-0/production wiring tests, and generated SDK via normal codegen. UI remains owned by the premium UX lane.
- **Invariant:** recent peer activity is one bounded Tier-0 producer read per settings snapshot, never N reads per peer, never Session/workspace hydration, and never exposes target refs/request/result digests in the default settings state.
- **Changes made:** claim established after Core `OfxpInvocation.recent()` landed and passed 7/7 with retention/bounds.
- **Verification performed:** current settings state has no activity field; Core supports one global newest-first read capped at 100.
- **Remaining concerns:** select a compact last-activity-per-peer projection from the bounded global read; preserve zero-Instance production wiring and SDK compatibility.
- **Handoff/request:** premium UI owner may render the optional compact last-activity field after API/codegen lands; do not add polling or receipt-by-receipt requests.

- **Claim extension:** `packages/sdk/js/test/ofxp-settings-contract.test.ts` for the generated `OfxpSettingsState.activity` response contract only.

## 2026-09-20 18:13 CT — ChatGPT settings-root truthfulness claim
- **Files claimed:** OFXP settings root projection schema in `packages/opencode/src/server/routes/instance/httpapi/groups/ofxp.ts` and generated V2 SDK output from the canonical generator. No handler/UI/Core root-execution files claimed.
- **Invariant:** Settings reports durable approval metadata only; it must not claim live filesystem availability without a producer-owned liveness signal. No per-root probes or polling fanout are allowed.
- **Changes made:** claim established.
- **Verification performed:** Effect Struct encoding strips excess object fields, so the existing batched handler may continue consuming Core `PublicRoot` rows while the HTTP success schema safely projects only settings-owned fields.
- **Remaining concerns:** regenerate SDK from the live OpenAPI graph and verify the UI compiles against the narrower root shape.
- **Handoff/request:** protocol-wide `Ofxp.PublicRoot.available` remains untouched; execution-time root verification stays owned by `OfxpRoot`.

## 2026-09-20 18:15 CT — ChatGPT OFXP production wiring hotfix closeout

- **Files claimed:** releasing the narrow server composition/build-restart lane; no additional product source edits were required because the concurrent hotfix had already landed in the live tree.
- **Invariant:** a route handler that directly requires `OfxpPeer.Service` must receive `OfxpPeer.node` as an exported top-level server service; transitive dependencies of `OfxpRuntime.node` remain private.
- **Changes made:** rebuilt `packages/opencode/dist/node/node.js` and restarted the sanctioned OpenFork desktop dev stack through `bun run dev`, forcing Electron to load the corrected graph.
- **Verification performed:** live source and emitted bundle both place `OfxpPeer.node` immediately before `OfxpRuntime.node`; `test/server/httpapi-ofxp-production-wiring.test.ts` passes 1/1 through the real `HttpApiApp.webHandler()`; restarted sidecar reached `server ready` on a fresh ephemeral port without the reported `Service not found: @opencode/core/OfxpPeer` failure.
- **Remaining concerns:** unrelated startup logs still report the pre-existing OXP project-root sync error and LM Studio plugin type-stripping issue; neither is this OFXP service-wiring defect.
- **Handoff/request:** none for this incident; keep the production-wiring regression test so future LayerNode refactors cannot reintroduce private-dependency/export confusion.

## 2026-09-20 18:16 CT — ChatGPT settings-root truthfulness DONE
- **Status:** DONE; releasing `groups/ofxp.ts` and generated SDK ownership to the active Settings activity-integration lane.
- **Invariant:** `OfxpSettings.PeerOverview.roots` is approval metadata, not liveness. Keep `OfxpSettingsApprovedRoot = { id, alias, source, approvedAt }`; do not reintroduce `available` or add filesystem probes to settings polling.
- **Changes made:** added the dedicated settings root schema and regenerated the V2 SDK; protocol-wide `Ofxp.PublicRoot` remains unchanged.
- **Verification performed:** generated SDK now types roots as `OfxpSettingsApprovedRoot[]` with no `available`; OFXP SDK contract passes 1/1; SDK package typecheck passes; Settings UI has zero target-file diagnostics against the narrower shape.
- **Remaining concerns:** none for root truthfulness.
- **Handoff/request:** activity integration owner must preserve this narrower root contract when regenerating SDK after adding activity fields.

## 2026-09-20 18:17 CT — ChatGPT OFXP batched-activity projection lane

- **Files claimed:** `packages/core/src/ofxp-invocation/index.ts` and `packages/core/test/ofxp-invocation-recent.test.ts` only.
- **Invariant:** attaching recent activity to multiple peer rows must use one bounded durable query, never one query/request per peer and never Session/transcript hydration.
- **Changes made:** claim re-opened to add a multi-peer batch projection on top of the verified `recent()` primitive.
- **Verification performed:** receipt storage is globally capped at 4096 rows and indexed by `(source_peer_id, created_at)`; a single filtered retained-row query can safely group per-peer summaries in memory without N fanout.
- **Remaining concerns:** cap peer count and per-peer rows; preserve newest-first order; do not expose raw target/digest detail by default in the eventual UI contract.
- **Handoff/request:** HTTP settings owner should consume this batch primitive when its handler claim is free.

## 2026-09-20 18:20 CT — ChatGPT runtime-preference failure-mode review
- **Files claimed:** none; runtime/config lane remains with its existing owner.
- **Invariant:** persisted enable preference and actual process runtime should converge even when the global-config write itself fails after a successful listener transition.
- **Changes made:** none.
- **Verification performed:** live runtime construction restores `globalConfig.ofxp.enabled === true` via `start()` and catches restore failures without failing application startup. Focused runtime suite passes 3/3.
- **Remaining concerns:** `setEnabled()` performs the runtime transition before `config.updateGlobal()`; a config-write failure can therefore leave runtime active with persisted disabled, or runtime stopped with persisted enabled. The Settings UI reconciles actual runtime state after the failed request, but restart intent can still diverge.
- **Handoff/request:** runtime-preference owner should add config-write-failure coverage and either roll back the runtime transition on persistence failure or document/implement an explicit convergent retry policy. Do not move this policy into the renderer.


## 2026-09-20 18:12 CT — ChatGPT settings-root contract lane

- **Files claimed:** `packages/opencode/src/server/routes/instance/httpapi/groups/ofxp.ts`; generated SDK output only via canonical codegen if the schema change lands; no handler/Core/UI files claimed.
- **Invariant:** the Settings operator projection must not present `Ofxp.PublicRoot.available` as live filesystem health. Settings owns approved-root identity/metadata only; actual host-path availability is verified at the capability operation boundary.
- **Changes made:** claim established after UI removed the misleading status dot; implementation pending.
- **Verification performed:** Settings currently types roots directly as `Ofxp.PublicRoot`, inheriting a boolean that Core intentionally cannot keep live without per-root filesystem polling.
- **Remaining concerns:** preserve root IDs/aliases/source/approval timestamps and avoid changing the OFXP wire-protocol `root.list` contract.
- **Handoff/request:** handler/UI owners should not add root liveness probing; this lane will narrow only the Settings response schema.

## 2026-09-20 18:18 CT — ChatGPT grant-expiry Core DONE
- **Status:** DONE; releasing the `setGrant()` expiry boundary and `ofxp-peer-grant-expiry.test.ts`.
- **Invariant:** omitted grant lifetime preserves the currently revision-fenced expiry; only explicit `null` clears it.
- **Changes made:** implemented atomic omission-preserves semantics in the durable Core update and added explicit-clear support.
- **Verification performed:** expiry suite 2/2, peer-domain suite 14/14, overview/root/CAS suite 5/5. Scoped Core typecheck reports only existing filesystem/skill/Bun-environment diagnostics and no modified-source diagnostic.
- **Remaining concerns:** none for lifetime widening. HTTP callers should omit lifetime unless intentionally replacing/clearing it; no pre-read is required.
- **Handoff/request:** premium UI may safely allow granular edits on time-bounded grants while continuing to display the expiry notice.

## 2026-09-20 18:14 CT — ChatGPT settings-root contract closeout

- **Files claimed:** none; releasing the duplicate route-schema claim without product edits.
- **Invariant:** Settings root metadata must not claim synchronous host-path liveness.
- **Changes made:** none from this lane; concurrent work had already introduced `OfxpSettings.ApprovedRoot` with only id/alias/source/approvedAt and removed `available` from the Settings projection.
- **Verification performed:** generated V2 SDK now exposes `OfxpSettingsApprovedRoot` and `OfxpSettingsPeerOverview.roots: Array<OfxpSettingsApprovedRoot>`; OFXP wire-protocol `Ofxp.PublicRoot` remains unchanged for protocol compatibility.
- **Remaining concerns:** none for root liveness in Settings; capability execution remains the authority boundary that verifies canonical host paths.
- **Handoff/request:** do not reintroduce filesystem-health polling into the 5s settings refresh path.

## 2026-09-20 18:16 CT — ChatGPT runtime persistence resilience review

- **Files claimed:** none; runtime-preference owner retains its files.
- **Invariant:** in-memory runtime state and persisted `ofxp.enabled` should converge even when the global config write itself fails.
- **Changes made:** none; review-only.
- **Verification performed:** normal enable/disable persistence passes 3/3. Current ordering transitions the runtime first and persists second, which correctly prevents a failed listener start from persisting enabled=true.
- **Remaining concerns:** a filesystem/config-write defect after a successful transition can leave runtime state and persisted preference divergent (notably disable-now/re-enable-on-next-start). Add compensation or explicit convergence semantics if config persistence failures are intended to be recoverable.
- **Handoff/request:** runtime owner should decide the failure contract; do not weaken the current start-before-enable-persist safety invariant.

## 2026-09-20 18:28 CT — ChatGPT runtime-preference resilience implementation

- **Files claimed:** continuing the existing runtime-preference ownership of `packages/opencode/src/ofxp/runtime.ts` and `packages/opencode/test/ofxp/runtime.test.ts` only.
- **Invariant:** a failed global-config write must leave the process runtime exactly as it was before `setEnabled()`; a failed listener start must never persist enabled=true.
- **Failure contract:** enable transitions first and compensates by stopping only when this call newly started the runtime; disable persists false before stopping, so a failed write leaves the prior runtime untouched.
- **Verification planned:** exercise config-write defects on both enable and disable, then prove normal recovery/convergence afterward.
- **Handoff/request:** renderer remains a state consumer; persistence compensation stays process-global.

## 2026-09-20 18:22 CT — ChatGPT OFXP authenticated-endpoint projection lane

- **Files claimed:** `packages/opencode/src/ofxp/connection-manager.ts` and `packages/opencode/test/ofxp/connection-manager.test.ts` only. Runtime/handler/UI remain with current owners.
- **Invariant:** connection detail is transient authenticated routing metadata, never durable peer identity; exposing it must not create health timers, reconnect loops, or network work.
- **Changes made:** claim established to retain the endpoint that actually completed TLS/OFXP negotiation and expose a read-only in-memory snapshot.
- **Verification performed:** discovery already supplies protocol version and candidate instances, but `OfxpConnectionManager.Manager` currently discards the selected endpoint after a successful failover/dial.
- **Remaining concerns:** snapshot must prune closed connections, report the actual successful endpoint rather than the newest discovery hint, and remain side-effect-free.
- **Handoff/request:** runtime/settings owner can later merge this transient snapshot with durable peer state; UI must label endpoint data as connection detail, never identity.

## 2026-09-20 18:25 CT — ChatGPT OFXP re-key continuity-proof lane

- **Files claimed:** OFXP-only schema additions in `packages/schema/src/ofxp.ts`; new `packages/core/src/ofxp-peer/rekey.ts`; new `packages/core/test/ofxp-rekey.test.ts`. No durable peer/runtime/pairing/UI files claimed.
- **Invariant:** identity rotation must not be represented as an endpoint change or local key overwrite. A re-key candidate requires cryptographic continuity from the old private key, same-realm binding, short expiry, and fresh operator/SAS confirmation before any trust mutation.
- **Changes made:** claim established for the proof primitive only; it will not transfer grants/roots or mutate trust.
- **Verification performed:** `peerID` is public-key-derived, while `realmID` is stable but untrusted. Current identity store cannot safely make remote peers forget an old compromised key. A signed old-key→new-identity proof is therefore necessary but intentionally insufficient for authorization.
- **Remaining concerns:** replay/expiry, canonical signed bytes, old-key/public-key binding, same-realm enforcement, and tamper rejection.
- **Handoff/request:** future peer/runtime owner should consume this proof inside a fresh pairing/re-key ceremony, revoke the old binding on explicit confirmation, and trust the new identity deny-by-default; never auto-copy grants/roots.

## 2026-09-20 18:24 CT — ChatGPT highlighted-concerns integration closeout
- **Status:** DONE for grant-expiry preservation and Settings root truthfulness.
- **Invariant:** granular grant edits never widen a bounded lifetime; Settings roots expose approval metadata only and never claim live host-path health.
- **Changes verified in final merged tree:** Core omission-preserves / explicit-null-clears expiry semantics; UI bounded-grant edits re-enabled with visible active/expired lifetime state; Settings root schema remains `OfxpSettingsApprovedRoot` without `available`; handler explicitly projects only root approval fields; activity remains one bounded Tier-0 query.
- **Verification performed:** expiry regression 2/2; Tier-0 HTTP 12/12; production OFXP wiring 1/1; SDK OFXP contract 1/1; SDK package typecheck passes; generated SDK contains `OfxpSettingsApprovedRoot[]` and bounded recent activity; app target files have zero target-file diagnostics (remaining diagnostics are existing project config/ImportMeta/SVG issues).
- **Remaining concerns:** none for the two highlighted issues.
- **Handoff/request:** preserve these invariants during subsequent runtime/endpoint/activity enhancements; never restore per-root health polling or omitted-expiry clearing.

## 2026-09-20 18:24 CT — ChatGPT SDK activity-fixture claim

- **Files claimed:** `packages/sdk/js/test/ofxp-settings-contract.test.ts` only.
- **Invariant:** the SDK contract fixture must structurally match the generated required `OfxpSettingsState`; additive settings fields must not be silently absent from the test response.
- **Changes made:** claim established after activity integration added required `activity`.
- **Verification performed:** generated state includes `activity: OfxpSettingsRecentActivity[]`; the SDK test fixture still omits it even though Bun runtime execution passes.
- **Remaining concerns:** add the empty activity projection and rerun the focused SDK contract test/package typecheck.
- **Handoff/request:** no generated SDK or production files are claimed.

## 2026-09-20 18:25 CT — ChatGPT SDK activity-fixture DONE

- **Status:** DONE; releasing `packages/sdk/js/test/ofxp-settings-contract.test.ts`.
- **Invariant:** SDK route fixtures track the generated required Settings state.
- **Changes made:** added `activity: []` to the typed OFXP settings fixture.
- **Verification performed:** focused SDK OFXP contract test passes and SDK package typecheck passes.
- **Remaining concerns:** none in this fixture.
- **Handoff/request:** future required Settings-state fields should update this fixture alongside codegen.

## 2026-09-20 18:29 CT — ChatGPT OFXP highlighted-gap integration handoff

- **Files claimed:** releasing `packages/core/src/ofxp-invocation/index.ts`, `packages/core/test/ofxp-invocation-recent.test.ts`, `packages/opencode/src/ofxp/connection-manager.ts`, `packages/opencode/test/ofxp/connection-manager.test.ts`, OFXP schema additions in `packages/schema/src/ofxp.ts`, and new Core re-key proof files after verification.
- **Invariant:** Settings consumes producer-owned compact facts; endpoint/discovery data is transient routing metadata, and re-key proof is continuity evidence only—not authority.
- **Changes made:** `OfxpInvocation.recentByPeer()` now provides one-query per-peer activity summaries (max 256 peers, default 5/max 20 receipts each); connection manager retains/snapshots the actually authenticated endpoint with zero I/O; `Ofxp.RekeyProof` + `OfxpRekey.create/verify` provide short-lived old-key→new-identity same-realm continuity proof without trust mutation.
- **Verification performed:** activity focused suite 3/3; existing+recent invocation suite previously 7/7; connection-manager suite 6/6; re-key proof suite 3/3; `packages/schema/src/ofxp.ts` scoped typecheck 0 diagnostics. Core/opencode scoped compiler noise remains existing Node/Bun/project-environment diagnostics, with no demonstrated modified-source semantic failure.
- **Remaining concerns:** Settings activity owner should switch from global `recent()` to `recentByPeer(peerIDs, perPeerLimit)` to avoid active-peer starvation. Runtime owner should expose `connections.snapshot()` and existing discovery `protocolVersion`/candidate instances without dialing. Re-key integration must bind the proof into a fresh SAS ceremony, explicitly revoke the old durable binding, trust the new identity deny-by-default, and never auto-copy grants/roots.
- **Handoff/request:** UI should show protocol/source/authenticated endpoint as connection details (not identity) and render only compact activity fields (operation/state/time/commit class). Do not expose target refs/digests by default. Do not add a Rotate Identity button until the runtime can atomically create/persist the continuity proof and complete the explicit re-key lifecycle.

## 2026-09-20 18:36 CT — ChatGPT authenticated-connection Settings integration

- **Files claimed:** narrow runtime projection in `packages/opencode/src/ofxp/runtime.ts`; Settings OFXP schema/handler; required runtime test-double lines; canonical generated SDK. UI remains unclaimed by this lane.
- **Invariant:** authenticated endpoint is transient routing detail from an already-open pooled connection. Reading Settings must never dial, reconnect, persist an endpoint, or treat it as durable identity.
- **Changes planned:** expose a side-effect-free runtime snapshot; merge candidate protocol version and authenticated endpoint into the existing batched peer overview.
- **Verification planned:** connection manager regression remains 6/6; runtime projection must be empty when inactive; Tier-0 and production graph tests must remain bootstrap-free.
- **Handoff/request:** UI should label these as connection details, never fingerprints/identity, and may omit them when unavailable.

- **Verification extension:** strengthening the existing Tier-0 ownership test with one trusted/discovered/authenticated peer so protocol/endpoint projection and activity redaction are asserted at the actual HTTP boundary.

## 2026-09-20 18:28 CT — ChatGPT OFXP settings batching regression claim

- **Files claimed:** new `packages/opencode/test/server/httpapi-ofxp-settings-batching.test.ts` only.
- **Invariant:** one Settings snapshot performs exactly one batched peer overview read and one bounded invocation-activity read; peer count must not multiply durable queries or trigger workspace services.
- **Changes made:** claim established; no production files touched.
- **Verification performed:** live handler currently composes `peers.overview()` and `invocations.recent({ limit: 20 })` once inside one `Effect.all`.
- **Remaining concerns:** lock invocation counts and response redaction in a focused handler regression without duplicating production implementation.
- **Handoff/request:** activity/runtime/UI owners retain their files; this lane is test-only.

## 2026-09-20 18:31 CT — ChatGPT activity-integration starvation review

- **Files claimed:** none; active Settings activity owner retains handler/schema/server files.
- **Invariant:** peer-card activity must not be biased toward whichever peer produced the globally newest receipts.
- **Changes made:** none; review-only.
- **Verification performed:** Core now provides `recentByPeer()` with de-duplicated peer IDs, bounded per-peer rows, and a one-query grouped projection; its cross-peer-starvation regression passes. The live settings handler still calls global `recent({ limit: 20 })`.
- **Remaining concerns:** if Settings activity is consumed per peer, switch the one settings snapshot read to `recentByPeer({ sourcePeerIDs: overview peer IDs, perPeerLimit: ... })` or an equivalent single-query grouped projection; do not use one `recent()` call per peer.
- **Handoff/request:** activity integration owner should align the HTTP projection with the new batched producer before the premium UI renders peer-specific activity.

## 2026-09-20 18:33 CT — ChatGPT settings-batching regression claim released

- **Files claimed:** none; no test file was created.
- **Invariant:** settings activity remains one bounded producer query, never N-per-peer.
- **Changes made:** none; existing Tier-0 tests already lock redaction/bootstrap ownership, while the active activity owner is aligning the handler with Core `recentByPeer()`.
- **Verification performed:** Core cross-peer-starvation regression exists and passes; HTTP Tier-0 and production wiring tests remain green.
- **Remaining concerns:** handler should consume the batched per-peer primitive before peer-card activity is rendered.
- **Handoff/request:** active activity lane retains implementation ownership.

## 2026-09-20 18:35 CT — ChatGPT re-key storage-safety review

- **Files claimed:** none; re-key proof primitive is complete/released and runtime/config lane remains owned elsewhere.
- **Invariant:** rotating the local host identity must be atomic across all OpenFork processes sharing one durable realm; a renderer action or unconditional file rename must never clobber a concurrently rotated key.
- **Changes made:** none; review-only boundary decision.
- **Verification performed:** `OfxpIdentityStore.FileStore` deliberately implements only atomic create-if-absent via temp-file + hard-link; repository has no existing cross-process lock/CAS replacement primitive. Runtime tests also use the minimal `Store` contract. A safe rotate therefore requires an explicit process/realm transaction or a purpose-built compare-and-swap store contract, not deletion/overwrite of `identity.json`.
- **Remaining concerns:** define crash recovery/stale-lock semantics and multi-process coordination before local key replacement is wired. The already-implemented `Ofxp.RekeyProof` solves remote cryptographic continuity, not local storage serialization.
- **Handoff/request:** do not expose Rotate Identity in Settings until runtime owns both halves: atomic local key replacement and fresh SAS re-key confirmation/revocation of old trust. Realm correlation alone is not authorization.

## 2026-09-20 18:38 CT — ChatGPT OFXP backend-targeting defect

- **Files claimed:** none; premium UI owner retains `ofxp-network.tsx`.
- **Invariant:** every OFXP operator read/mutation must target the exact ServerConnection that scopes the current Settings surface; backend selection is authority context and must never be inferred from an unrelated picker store.
- **Changes made:** none; review-only handoff.
- **Verification performed:** route Settings scopes `ServerSDKProvider` / `ServerSyncProvider` from `?server=` (or current server), and Providers/Models consume those contexts. OFXP instead calls `global.settings.server.selected()`; the only writer of that independent setting is the legacy `SettingsServerPicker`, which v2 Settings does not render.
- **Remaining concerns:** OFXP can display/mutate a different backend than the Settings route/dialog context, especially with multiple servers or a non-first active server.
- **Handoff/request:** refactor OFXP to consume the scoped server SDK/context as the source of truth (and derive display/local/project metadata from that same connection/context). Do not merely synchronize two stores; remove the split authority source.

## 2026-09-20 18:42 CT — ChatGPT activity cardinality contract defect

- **Files claimed:** none; active Settings activity/endpoint owner retains group/handler/generated SDK.
- **Invariant:** every valid Tier-0 settings snapshot must satisfy its response schema for the maximum supported trusted-peer cardinality; batching bounds must agree across producer, handler, and HTTP schema.
- **Changes made:** none; review-only defect handoff.
- **Verification performed:** Core `recentByPeer()` accepts/caps up to 256 peer IDs and `perPeerLimit: 1` can therefore emit up to 256 receipts. The live handler flattens those receipts directly, while `OfxpSettingsState.activity` is capped with `Schema.isMaxLength(20)`.
- **Remaining concerns:** >20 peers with recent activity can violate response encoding. Decide the operator contract explicitly: either make activity one-per-peer up to the same bounded peer ceiling, or select a deterministic/fair top-20 and document which peers may lack activity. Do not regress to global-recency starvation or N queries.
- **Handoff/request:** activity owner should align Core batch bound, HTTP schema, generated SDK, and tests in one change and add a >20-peer regression.

## 2026-09-20 18:49 CT — ChatGPT activity-cardinality regression

- **Files claimed:** new `packages/opencode/test/server/ofxp-settings-schema.test.ts` only.
- **Invariant:** Settings activity accepts the producer-supported one-row-per-peer ceiling (256) while rejecting payloads beyond that hard bound.
- **Changes verified before test:** live HTTP schema now caps activity at 256 and handler requests `recentByPeer(..., perPeerLimit: 1)`; Tier-0 route test remains 12/12.
- **Handoff/request:** no product files are claimed by this regression lane.

## 2026-09-20 18:44 CT — ChatGPT connection-detail UI semantics review

- **Files claimed:** none; premium UI owner retains OFXP TSX/CSS/i18n.
- **Invariant:** UI labels must distinguish identity, discovery presence, and authenticated connection routing; `online` may summarize presence but supporting labels/details must stay semantically precise.
- **Changes made:** none; review-only.
- **Verification performed:** backend now sets `peer.online` when either a discovery candidate or authenticated pooled connection exists and projects `protocolVersion` / `authenticatedEndpoint`. UI still contains a discovery-only comment/memo name and currently renders only version in peer facts.
- **Remaining concerns:** update stale discovery-only naming/comment; optionally show protocol and authenticated endpoint as subordinate “Connection” facts, explicitly not identity. Never initiate a dial to populate them.
- **Handoff/request:** fold this into the same scoped-server fix/premium UI pass; backend targeting correctness takes precedence over cosmetic connection detail.

## 2026-09-20 18:47 CT — ChatGPT OFXP identity CAS prerequisite lane

- **Files claimed:** `packages/core/src/ofxp-peer/identity-store.ts` and `packages/core/test/ofxp-identity-store.test.ts` only.
- **Invariant:** future local identity rotation must compare-and-swap the exact current durable identity under cross-process serialization; stale writers must never overwrite a newer key and readers must never observe a delete/replace gap.
- **Changes planned:** add a rotatable-store capability and a FileStore CAS implemented with the existing stale-recovering `Flock` plus same-directory fsync'd atomic replacement. No runtime, pairing, trust, or UI rotation behavior is included.
- **Verification planned:** matching CAS succeeds; stale CAS is a no-op; concurrent rotations admit exactly one winner; reopened identity is always parseable and equals the winner.
- **Remaining concerns:** preserve current create-if-absent semantics and avoid forcing non-file/native secure stores to implement rotation before they are ready.
- **Handoff/request:** runtime/re-key owners may consume this only after this lane closes; do not expose a Rotate Identity control yet.

## 2026-09-20 18:53 CT — ChatGPT OFXP identity CAS prerequisite DONE

- **Status:** DONE; releasing `packages/core/src/ofxp-peer/identity-store.ts` and `packages/core/test/ofxp-identity-store.test.ts`.
- **Invariant:** local identity replacement is opt-in and compare-and-swap; stale/concurrent writers cannot overwrite the winning key and no delete/replace visibility gap is introduced.
- **Changes made:** added `RotatableStore`, `supportsRotation()`, `rotateIfCurrent()`, and FileStore CAS using the existing heartbeat/stale-recovering Flock plus fsync'd same-directory atomic rename and POSIX directory sync. Existing Store/load-or-create semantics remain unchanged.
- **Verification performed:** focused identity-store suite 5/5, including stale rejection and exactly-one-winner eight-way concurrent rotation. Package typecheck reports only existing filesystem/skill symbols and unrelated branded-root test diagnostics; no CAS source/test diagnostic.
- **Remaining concerns:** this is storage serialization only. Runtime still must coordinate listener teardown/startup, create continuity proof from the old key, persist atomically, and complete explicit SAS re-key before any remote trust transition.
- **Handoff/request:** future runtime rotation must feature-detect `supportsRotation(store)`; never emulate rotation for a Store that lacks atomic replacement, and never auto-copy peer grants/roots.

## 2026-09-20 18:59 CT — ChatGPT OFXP end-to-end re-key integration claim

- **Status:** CLAIMED / WORKING.
- **Files claimed:** re-key-only additions/edits in `packages/schema/src/ofxp.ts`, `packages/core/src/ofxp-peer/pairing.ts`, `packages/core/src/ofxp-peer/index.ts`, focused Core re-key/pairing tests, `packages/opencode/src/ofxp/runtime.ts`, `packages/opencode/src/ofxp/transport.ts`, focused OFXP runtime/transport tests, and the narrow Settings/API surface only if required after the lifecycle is complete. UI TSX/CSS/i18n remain outside this claim unless the backend ceremony closes completely.
- **Scientific/security objective:** integrate identity rotation without confusing endpoint change, realm correlation, or possession of the new key with authorization. Continuity proof must be signed by the old key, the new peer identity must match TLS, SAS must be freshly operator-confirmed, and the durable transition must revoke the old binding while creating the new binding deny-by-default with no grant/root transfer.
- **Invariants:** standard pairing remains backward-compatible; continuity proof is optional and valid only for same-realm old-key→new-key replacement; either pairing direction can carry the rotating side's proof; confirmation is the only durable trust mutation point; no automatic grant/root copy; no renderer-owned cryptography/storage mutation.
- **Status before edits:** storage CAS prerequisite 5/5 and proof primitive 3/3 are complete/released; no runtime re-key owner is active in the live ledger.
- **Planned verification:** proof tamper/expiry + pairing both directions, stale/unknown previous identity rejection, atomic old-revoke/new-deny transition, runtime listener/key restart behavior, and existing normal pairing/runtime/Tier-0 regressions.

## 2026-09-20 19:00 CT — ChatGPT runtime-preference resilience DONE

- **Status:** DONE; releasing the earlier runtime-preference resilience claim. The newer end-to-end re-key lane now owns any further `runtime.ts` changes.
- **Invariant:** a failed global-config write leaves OFXP runtime in its pre-call state; failed listener start never persists enabled=true.
- **Changes made:** enable starts first and compensates a newly-started listener if preference persistence fails; disable persists false before convergent teardown, so a failed write leaves the active runtime untouched.
- **Verification performed:** `test/ofxp/runtime.test.ts` passes 4/4, including enable-write rollback and disable-write no-teardown-on-failure; 25 assertions.
- **Remaining concerns:** none for enable-preference convergence. Re-key/runtime lifecycle work is explicitly owned by the 18:59 lane.

## 2026-09-20 19:00 CT — ChatGPT Settings activity integration DONE

- **Status:** DONE; releasing Settings activity schema/handler ownership and the cardinality regression.
- **Invariant:** one Settings snapshot performs one bounded durable activity query, returns at most one newest compact receipt per trusted peer, cannot starve quiet peers behind noisy peers, and never exposes invocation IDs, target refs, request digests, or result digests.
- **Changes made:** Settings consumes `OfxpInvocation.recentByPeer({ sourcePeerIDs, perPeerLimit: 1 })`; response cardinality is aligned to the producer ceiling of 256 peers.
- **Verification performed:** Core activity suite 3/3; Tier-0 HTTP 12/12; production OFXP wiring 1/1; new `ofxp-settings-schema.test.ts` passes 1/1 and proves 256 rows are accepted while 257 are rejected.
- **Remaining concerns:** UI presentation remains with the premium UI owner; do not regress to global top-N activity or N-per-peer reads.

## 2026-09-20 19:00 CT — ChatGPT authenticated-connection Settings integration DONE

- **Status:** DONE; releasing backend endpoint/protocol projection ownership. Further `runtime.ts` work belongs to the active end-to-end re-key lane.
- **Invariant:** connection detail is transient authenticated routing metadata only; reading Settings never dials, reconnects, persists endpoints, or treats them as durable identity.
- **Changes made:** runtime exposes side-effect-free `connectionStatuses()` backed by `connections.snapshot()`; Settings projects discovery `protocolVersion` plus the endpoint that actually authenticated and marks a peer online when either discovery or an open authenticated connection is present.
- **Verification performed:** connection-manager suite 6/6; runtime suite 4/4; Tier-0 HTTP 12/12 with a non-empty discovered/authenticated peer projection; production wiring 1/1; SDK OFXP contract 1/1. Generated SDK contains `OfxpSettingsAuthenticatedEndpoint`, protocol fields, and compact activity.
- **Remaining concerns:** UI must label endpoint/protocol as connection detail rather than identity and must use the scoped Settings server context; the backend-targeting defect recorded at 18:38 remains the highest-priority UI correctness issue.

## 2026-09-20 19:00 CT — ChatGPT incomplete-closeout resolved

- **Status:** DONE.
- **Changes made:** executed the previously unrun activity-cardinality regression and recorded final closeouts for runtime persistence, fair/bounded activity, and authenticated endpoint/protocol projection.
- **Verification performed:** final live-tree matrix is green: runtime 4/4; activity 3/3; connection manager 6/6; Tier-0 HTTP 12/12; production OFXP wiring 1/1; SDK OFXP contract 1/1; activity-cardinality schema 1/1.
- **Remaining concerns:** no backend loose ends from this closeout. Do not edit re-key-claimed files without coordinating with the 18:59 owner; premium UI still owns the scoped-server targeting/connection-detail rendering pass.

## 2026-09-20 19:03 CT — ChatGPT OFXP UI architecture regression lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** new `packages/app/src/components/settings-v2/ofxp-network-architecture.test.ts` only. `ofxp-network.tsx`, OFXP CSS, i18n, and re-key-owned backend files remain untouched.
- **Invariant:** OFXP Settings must derive backend authority, project projection, and locality from the scoped Settings server providers; no independent legacy server picker may participate. Older GETs must never overwrite state returned by a newer mutation or backend switch.
- **Verification target:** source-architecture regression matching existing repository precedent, plus targeted app test execution.
- **Handoff/request:** premium UI owner may continue editing its claimed files; this lane is read-only against them and will only lock the resulting invariants.

## 2026-09-20 19:06 CT — ChatGPT OFXP UI architecture regression DONE

- **Status:** DONE; releasing the new test-only file claim.
- **Changes made:** added `packages/app/src/components/settings-v2/ofxp-network-architecture.test.ts` using the repository's existing source-architecture test pattern. No UI production source was edited.
- **Verification performed:** app unit-test harness passes 2/2 with 15 assertions. The test locks scoped `ServerSDK` / `ServerSync` authority, project/locality derivation from the same scoped server, absence of the legacy independent server selector, and request-ID fencing across mutations/backend switches.
- **Compiler note:** targeted app compilation still reports only the known project-level compiler-option / ImportMeta / SVG diagnostics; no production OFXP Settings target-file diagnostic was introduced. The generic file-mode compiler does not load Bun test globals for unit-test files, matching existing app test limitations.
- **Handoff/request:** premium UI owner retains its TSX/CSS/i18n ownership; future refactors must keep this regression green.

## 2026-09-20 19:06 CT — ChatGPT backend-targeting defect verification resolved

- **Status:** VERIFIED RESOLVED in the live UI; no production edit from this lane.
- **Verification performed:** `ofxp-network.tsx` now derives `scopedServer` from `useServerSDK()`, API calls from `serverSDK().client.ofxp`, projects from `useServerSync()`, and desktop/locality decisions from that same scoped server. `global.settings.server.selected` and `SettingsServerPicker` are absent. Backend changes invalidate both state and busy request generations before reloading.
- **Remaining concerns:** none for split backend authority or stale GET overwrite. UI semantics/polish and any re-key controls remain owned by their active lanes.

## 2026-09-20 19:08 CT — ChatGPT re-key core read-only verification

- **Files claimed:** none; the 18:59 end-to-end re-key owner retains all implementation files.
- **Changes made:** none.
- **Verification performed against the live concurrent tree:** continuity proof 3/3; pairing transcript 9/9 including initiator/responder proof carriage and mismatched-proof rejection; durable old→new trust transition 4/4 including replay/tamper/independent-trust rejection; identity-store/CAS suite 6/6 including exactly-one-winner concurrent rotation and atomic persistence of crash-recovery continuity proof.
- **Remaining concerns:** runtime listener/key restart, transport ceremony, and final Settings/API exposure remain owned by the active re-key lane and were not modified by this verifier.
- **Handoff/request:** re-key owner can treat these Core/storage foundations as green at this checkpoint.


## 2026-09-20 19:22 CT — ChatGPT end-to-end re-key UI expansion

- **Status:** WORKING; extending the existing 18:59 re-key claim now that the backend ceremony is green.
- **Files claimed:** re-key-only edits in `packages/app/src/components/settings-v2/ofxp-network.tsx`, OFXP-only CSS if required, and OFXP English i18n keys. No unrelated Settings UI.
- **Invariant:** identity rotation is an explicit destructive operator action; the renderer never handles key material/proofs, never auto-pairs peers, never transfers grants/roots, and never finalizes continuity implicitly.
- **Backend gate satisfied:** runtime 9/9; Tier-0 HTTP 14/14; SDK OFXP contract 1/1; SDK typecheck clean; Core re-key/storage/pairing suites green.
- **UX contract:** two-step rotate confirmation; show old→new continuity state and expiry; trusted online peers get explicit fresh-SAS re-verification actions while continuity is valid; incoming continuity claims are visibly labeled in pending pairing cards; finalization is explicit and warns that remaining peers will require ordinary fresh pairing.
- **Handoff/request:** other UI work may continue outside these re-key-specific lines; preserve scoped-server authority and request-generation fencing.

## 2026-09-20 19:25 CT — ChatGPT re-key UI fresh-SAS gap (read-only review)

- **Files claimed:** none; the 19:22 re-key UI owner retains TSX/CSS/i18n.
- **Invariant:** while this runtime's local continuity proof is valid, the operator must be able to initiate a fresh SAS ceremony with an already-trusted discovered peer so that peer can verify old-local-ID → new-local-ID continuity. This action transfers no authority automatically.
- **Finding:** the only live `beginPairing(candidate.peerID)` control is rendered in the Nearby list, while `nearby()` filters out every peer already present in `peers()`. No trusted-peer detail action currently calls `beginPairing(peer.info.id)`. Therefore the advertised "trusted online peers get explicit fresh-SAS re-verification actions" UX is not yet implemented.
- **Backend check:** `OfxpRuntime.initiatePairing(peerID)` accepts any currently discovered candidate and attaches `validContinuityProof(current)`; it does not reject an already-trusted peer. The missing piece is renderer reachability, not backend capability.
- **Handoff/request:** during an active, unexpired local rotation journal, add an explicit re-verify action on a trusted peer only when that peer is currently discoverable/pairable. Route it through the existing `beginPairing(peer.info.id)` path and existing two-sided SAS confirmation. Do not copy grants/roots or auto-confirm.

## 2026-09-20 19:27 CT — ChatGPT re-key end-to-end verification checkpoint

- **Files claimed:** none; implementation remains with the active 18:59 / 19:22 re-key owner.
- **Verification performed against the live tree:** runtime 9/9; transport 5/5; pairing transcript 9/9; continuity proof 3/3; identity store/journal 7/7; Tier-0 HTTP 14/14; SDK OFXP contract 1/1.
- **Security properties observed:** local rotation requires atomic-store support; continuity proof is short-lived and old-key signed; listener identity is stopped before durable key publication; CAS losers converge on the durable winner; old trust mutates only after fresh SAS confirmation; no grant/root transfer occurs; explicit finalization is required before another rotation.
- **Remaining concerns:** renderer reachability for fresh SAS with already-trusted peers is still the active UI gap recorded at 19:25. Continuity-claim wording should not imply that the previous identity was already trusted when the backend intentionally falls back to ordinary deny-by-default trust for an unknown previous peer.
- **Handoff/request:** no backend change requested from this verification lane.

## 2026-09-20 19:29 CT — ChatGPT trusted-peer re-verification semantics check

- **Files claimed:** none; read-only review for the active re-key UI lane.
- **Finding:** the existing fresh-SAS path is safe to reuse for an unchanged already-trusted remote peer. `OfxpPeer.trust()` preserves the existing grant row and roots when the peer is active/non-revoked; authority/root reset occurs only when explicitly repairing a revoked identity.
- **Implication:** a local post-rotation "Re-verify" action may call `beginPairing(peer.info.id)` and ordinary `confirmPairing` without erasing this runtime's authority configuration for that unchanged remote identity. On the remote side, the carried local continuity proof still drives `rekeyTrust()`, which revokes the old local identity and creates the replacement deny-by-default.
- **UI gating:** show the action only when the local rotation journal is active/unexpired and a discovery candidate with the same peer ID is currently pairable; `peer.online` alone is insufficient because it may reflect only an authenticated pooled connection with no discovery endpoint for a new pairing ceremony.
- **Handoff/request:** no Core/runtime change required for this UX gap.

## 2026-09-20 19:32 CT — ChatGPT re-key proof finalization overlap defect

- **Files claimed:** none; active end-to-end re-key owner retains runtime/store/UI implementation.
- **Invariant:** operator finalization must not imply revocation of continuity material that cryptography cannot actually revoke, and a new rotation must not create overlapping valid continuity chains that can make remote peers transition onto an already-obsolete intermediate identity.
- **Finding:** Ofxp.RekeyProof is a self-contained old-key signature valid for 5 minutes. Once embedded in a remote pending pairing transcript, clearing this runtime's durable continuity journal cannot invalidate that remote copy. Current finalizeIdentityRotation() permits clearing an unexpired proof, and the runtime test explicitly verifies an immediate second B→C rotation after finalizing A→B.
- **Impact:** no capability/root authority is transferred, so this is not an authority escalation. However a remote peer can still confirm the already-issued A→B proof after local finalization/second rotation and end up trusting obsolete B deny-by-default while the live runtime is C. The UI text saying peers can no longer prove continuity after early finalization is therefore stronger than the protocol guarantee.
- **Recommended safe contract:** simplest is to reject finalization while continuityProof.expiresAt > now, then allow journal clearing/new rotation only after natural expiry. If early "stop offering" is required, persist a separate finalized/suppressed state while retaining the original expiry as a durable no-next-rotation barrier; already-issued proof wording must explicitly say it remains valid until expiry.
- **Required regression:** issue A→B proof into a remote pending transcript, attempt early finalization/second rotation, and prove the runtime cannot create B→C until A→B's cryptographic validity window has ended.
- **Handoff/request:** resolve this in the active backend lifecycle lane before considering the re-key UI complete.

## 2026-09-20 19:35 CT — ChatGPT stale rotate/finalize concurrency defect

- **Files claimed:** none; active re-key owner retains API/runtime/UI implementation.
- **Invariant:** destructive identity lifecycle commands must be optimistic-concurrency fenced against the exact runtime identity the operator viewed. Renderer-local request generations are insufficient because multiple Settings clients/process operators can race.
- **Finding:** rotateIdentity and finalizeIdentityRotation currently accept no payload/revision and the runtime methods accept no expected identity. A stale client can therefore act on a newer identity/rotation than the one shown in its UI.
- **Concrete race:** client A observes rotation A→B. Client B finalizes A→B and rotates B→C. Client A's stale Finalize request then clears C's current continuity journal because finalizeIdentityRotation operates on whichever proof is current. Likewise a stale Rotate click can rotate a newer identity than the operator intended.
- **Required contract:** include expectedPeerID (the currently displayed local runtime peer ID) in both rotate and finalize requests, and verify it inside the same SynchronizedRef critical section before closing listeners or touching durable identity state. A mismatch should be a typed conflict/HTTP 409, followed by normal Settings state reconciliation. For finalize, expectedPeerID is sufficient to distinguish generations because every successful rotation changes peer ID; expected previousPeerID/expiry may be added for stronger diagnostics.
- **Required regression:** simulate two operator generations and prove stale rotate/finalize cannot mutate the newer identity or journal. Keep UI two-step confirmation, but treat server-side CAS fencing as the authority boundary.
- **Handoff/request:** fix this before exposing rotation as production-complete.

## 2026-09-20 19:38 CT — ChatGPT stale revoke/root-add authority-generation defects

- **Files claimed:** none; Core peer/API surfaces currently overlap the active re-key owner, so this is read-only review.
- **Invariant:** destructive or authority-adding Settings mutations must apply to the exact peer trust generation the operator viewed. Revoke→fresh-pair is a new trust generation even when the cryptographic peer ID is unchanged.
- **Stale revoke race:** revoke currently accepts only peerID. Client A can hold an old peer card, client B can revoke and freshly re-pair that same key (which intentionally resets grant/root authority), then A's stale revoke can revoke the newly established trust because the peer ID is unchanged and no generation token is checked.
- **Stale root-add race:** approveRoot checks revoked state before its root transaction but carries no expected peer/grant generation. An old request can read active, race through revoke→fresh-pair (which clears roots), then insert its stale root after repair, violating the intended authority reset boundary.
- **Why grant edits are safe:** setGrant already carries expectedGrantRevision and its SQL update CAS fails after repair because repair increments the grant revision.
- **Recommended contract:** add expectedGrantRevision from the Settings peer snapshot to revoke and root-add mutations. Verify the revision plus non-revoked peer state inside the same durable transaction/critical mutation boundary, returning typed 409 on mismatch. Over-fencing a root add after an unrelated concurrent grant edit is acceptable; the UI already reconciles/retries from the compact state.
- **Root removal note:** removal is keyed by rootID and is authority-reducing; repair deletes old roots and a later re-approval receives a new root ID, so stale old-ID removal does not resurrect or target new authority.
- **Required regressions:** stale revoke after revoke→repair cannot revoke the repaired generation; stale root-add begun before revoke→repair cannot attach a root to the repaired generation.
- **Handoff/request:** coordinate with the active Core/re-key owner before touching index.ts; fix once that ownership boundary is free or fold it into that lane deliberately.

## 2026-09-20 19:41 CT — ChatGPT Settings privacy-contract verification

- **Files claimed:** none; generated SDK and production surfaces were inspected read-only.
- **Verification performed:** renderer-facing rotation status exposes only previousPeerID / expiresAt / expired; pairing continuity claim exposes only previousPeerID / expiresAt; approved roots expose id / alias / source / approvedAt without canonical paths; activity exposes source peer / operation / commit class / state / timestamps without invocation IDs, target refs, request digests, or result digests; authenticated endpoint exposes only current routing host/port/pending count.
- **Sensitive-material result:** no continuity signature, private key, public-key PEM, canonical root path, invocation ID, or receipt digest is present in OfxpSettingsState generated types.
- **Handoff/request:** preserve this reduced projection while adding optimistic-fencing payloads; expected peer/revision tokens are safe operator concurrency metadata and do not require exposing proof/key material.

## 2026-09-20 19:44 CT — ChatGPT discovery-provider architecture gap

- **Files claimed:** none; read-only architecture review.
- **Normative plan:** OFXP v1 discovery specifies MdnsOfxpDiscovery, KnownPeerDiscovery reconnect hints, and ServerConnectionDiscovery bootstrap, all feeding one bounded candidate model without bypassing cryptographic pairing/trust.
- **Live state:** OfxpRuntime candidates and outbound target resolution read only from Mdns.directory. There is no known-peer seed provider and no ServerConnection seed provider under packages/opencode/src/ofxp.
- **Impact:** same-link LAN discovery works and mDNS failure degrades cleanly without killing the listener, but a degraded/headless/routed peer has no alternate bootstrap/reconnect path even when OpenFork already has a configured server connection. This is a connectivity/architecture completeness gap, not an authority bypass.
- **Scope decision:** do not wire legacy ServerConnection state directly into peer trust or the Settings renderer. Any fix should introduce a producer-owned passive candidate provider feeding the same bounded directory/target resolution contract, with cryptographic identity still verified at transport/pairing.
- **Handoff/request:** track separately from the current re-key UI closure; it is not required to preserve the Settings separation invariant, but it remains unimplemented normative OFXP v1 work.

## 2026-09-20 19:48 CT — ChatGPT revoke/pending-pairing lifecycle defect

- **Files claimed:** none; pairing/runtime/Core files remain with the active re-key owner.
- **Invariant:** explicit revocation is a hard trust-generation boundary. A pairing transcript created before that revocation must not remain confirmable afterward and silently repair trust from stale operator state.
- **Finding:** OfxpPairing.Coordinator keeps pending transcripts until expiry/cancel/confirmation. The Settings revoke handler calls peers.revoke(peerID) directly and does not cancel pending coordinator entries for that peer. Runtime confirmPairing then calls peers.trust() for a normal transcript, which intentionally repairs a revoked same-key identity and resets authority/roots. Therefore a pre-revoke pending SAS can be confirmed post-revoke and establish a new trust generation.
- **Recommended contract:** revocation should invalidate all pending pairing transcripts whose remote peer ID matches the revoked peer, or confirmation should carry/validate a trust-generation fence proving the ceremony began after the current revocation boundary. The former is simpler if Coordinator gains cancelPeer(peerID); the latter is stronger for multi-process/runtime reconstruction.
- **Data-plane note:** revoked peers already fail closed for outbound calls before dial and for inbound capability/receipt dispatch via live peers.access checks; process handles retire on peer changes. Existing pooled TLS sockets may remain physically open, which is a separate lower-severity normative cleanup issue because they no longer have authority.
- **Required regression:** begin pairing with an already-trusted peer, revoke it before SAS confirmation, then prove the old pairing ID cannot re-trust the peer. A genuinely new post-revoke pairing may still repair trust deny-by-default.
- **Handoff/request:** fold this into the trust-generation fencing work while Core/runtime ownership is already active.

## 2026-09-20 19:51 CT — ChatGPT provider-neutral discovery directory lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/src/ofxp/discovery.ts` and `packages/opencode/test/ofxp/discovery.test.ts` only. Runtime/client/Settings/trust files remain with their current owners.
- **Objective:** remove the mDNS-only directory-shape blocker for the normative KnownPeerDiscovery and ServerConnectionDiscovery providers without wiring renderer/server state into trust.
- **Invariant:** every provider feeds the same bounded, secret-free untrusted candidate model; self-filtering, candidate/endpoint bounds, protocol validation, and zero per-peer timers remain centralized in Directory. Provider seeds grant no trust and perform no network I/O by themselves.
- **Planned change:** retain the existing mDNS API while adding validated passive seed up/down support and provider identity on candidate instances. No runtime integration in this lane.
- **Verification:** extend the existing discovery suite for cross-provider dedupe, self-filtering, validation, provider removal, peer/instance bounds, and unchanged mDNS behavior.

## 2026-09-20 19:56 CT — ChatGPT provider-neutral discovery directory DONE

- **Status:** DONE; releasing `packages/opencode/src/ofxp/discovery.ts` and `packages/opencode/test/ofxp/discovery.test.ts`.
- **Changes made:** Directory now stores source-qualified instances and retains the existing mDNS up/down API while adding validated `known` / `server` passive seed projection plus upSeed/downSeed. Candidate instances expose provider source/id, with fqdn retained only for mDNS. All providers share the same self-filtering, protocol/host/port validation, max-256 peer bound, max-8 instances-per-peer bound, and no per-peer timers.
- **Trust boundary:** passive seeds remain untrusted routing hints only. This lane adds no network requests, credentials, durable trust, pairing shortcuts, runtime integration, or renderer coupling.
- **Verification performed:** discovery suite passes 8/8 with 31 assertions covering unchanged mDNS projection, malformed inputs, passive seed validation, cross-provider dedupe/removal, self-filtering, candidate bound, and endpoint-fanout bound. Scoped production compilation reports no target discovery/runtime diagnostics; remaining diagnostics are the existing filesystem/skill/WASM/archive environment issues. Test-only file mode still lacks Bun globals, matching repository test tooling.
- **Remaining work:** implement producer-owned KnownPeerDiscovery and ServerConnectionDiscovery sources and feed these seeds into the active runtime's target resolution once runtime ownership is free. Do not read app persistence or credentials from the trust owner.

## 2026-09-20 19:59 CT — ChatGPT pairing per-source rate-limit defect

- **Files claimed:** none; `ofxp/transport.ts` remains inside the active end-to-end re-key/transport claim.
- **Normative invariant:** public pairing bootstrap requires both per-source and process-global rate limits; the source identity must not be attacker-controlled pairing identity material.
- **Finding:** PairRateLimiter itself is bounded (12/source/minute, 96/global/minute, max 512 source rows), but `sourceKey()` is `remoteAddress | peerID`. The peer ID comes from the presented self-signed pairing certificate and is untrusted before pairing. One network source can therefore generate many peer identities and bypass the 12/min source bucket until the 96/min global cap.
- **Recommended fix:** key the per-source limiter by normalized `socket.remoteAddress` alone; if unavailable, use one shared fail-safe `unknown` bucket. A separate per-peer bucket may be added, but must not weaken the network-source bucket. Preserve the existing global cap/source-map bound.
- **Coverage gap:** current transport suite 5/5 does not exercise rate limiting. Add deterministic regression(s) proving identity rotation from one address cannot evade the per-source cap and many addresses still hit the global cap.
- **Handoff/request:** fold into active transport work; no Settings/API change required.

## 2026-09-20 20:02 CT — ChatGPT Settings separation regression lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** new `packages/app/src/components/settings-v2/servers-ofxp-architecture.test.ts` only. Production Servers/OFXP UI/CSS/i18n remain read-only.
- **Invariant:** OFXP cryptographic peer trust/capability exchange is the primary Network surface; ordinary ServerConnection management is a distinct subordinate section that only chooses which OpenFork backend the app manages and cannot imply peer trust/authority.
- **Verification target:** source-architecture regression for composition/order, separate copy keys, and ownership imports using the existing app architecture-test pattern.

## 2026-09-20 20:04 CT — ChatGPT Settings separation regression DONE

- **Status:** DONE; releasing `packages/app/src/components/settings-v2/servers-ofxp-architecture.test.ts`.
- **Verification performed:** canonical app Solid/happydom harness passes 3/3 with 13 assertions. It locks OFXP-before-legacy composition, separate app-server copy keys, backend-management ownership staying out of `ofxp-network.tsx`, and explicit copy that ServerConnection management grants no OFXP peer trust/capabilities.
- **Production changes:** none.

## 2026-09-20 20:07 CT — ChatGPT OFXP UI zero-workspace regression extension

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/app/src/components/settings-v2/ofxp-network-architecture.test.ts` only; production UI/context remains read-only.
- **Invariant:** opening/using OpenFork Network Settings must not acquire ambient workspace `Local`/workspace SDK ownership. It must stay on scoped server/Tier-0 contexts and passive project metadata.
- **Verification target:** extend the source-architecture test to reject `@/context/local`, `@/context/sdk`, `useLocal()`, and workspace `useSDK()` imports/calls while retaining scoped ServerSDK/ServerSync assertions.

## 2026-09-20 20:09 CT — ChatGPT OFXP UI zero-workspace regression DONE

- **Status:** DONE; releasing `packages/app/src/components/settings-v2/ofxp-network-architecture.test.ts` again.
- **Verification performed:** canonical app Solid/happydom harness passes 2/2 with 19 assertions. The architecture gate now explicitly rejects ambient workspace Local/SDK imports/calls while preserving scoped ServerSDK/ServerSync authority and stale-response fencing.
- **Production changes:** none.

## 2026-09-20 20:12 CT — ChatGPT passive-project metadata verification

- **Files claimed:** none; verification-only.
- **Invariant:** OFXP Settings may read scoped project metadata for root approval without bootstrapping a workspace runtime/Instance.
- **Verification performed:** `ofxp-network.tsx` consumes `serverSync().data.project`; the ServerSync/global path uses child stores with `bootstrap: false`. Canonical app child-store suite passes 6/6 with 47 assertions, including the regression that non-bootstrapping children remain passive until a real directory access.
- **Handoff/request:** preserve `bootstrap:false` project projection; do not replace the root chooser with ambient workspace Local/SDK state.

## 2026-09-20 20:15 CT — ChatGPT revoked-connection eviction regression lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/test/ofxp/connection-manager.test.ts` only; production connection manager/runtime remain read-only.
- **Invariant:** the connection pool's existing `closePeer(peerID)` primitive must deterministically evict and close only that peer's authenticated pooled connection, giving the runtime owner a safe hook for revoke/re-key teardown.
- **Verification target:** focused regression for closePeer idempotency/isolation; no production edit.

## 2026-09-20 20:17 CT — ChatGPT revoked-connection eviction regression DONE

- **Status:** DONE; releasing `packages/opencode/test/ofxp/connection-manager.test.ts`.
- **Verification performed:** connection-manager suite passes 7/7 with 23 assertions. New regression proves `closePeer(peerID)` closes/evicts only the targeted authenticated pooled connection, leaves other peers untouched, and is idempotent.
- **Handoff/request:** active runtime owner can subscribe peer-change events and call this tested primitive for revoke/re-key-required teardown; no connection-manager production change is needed.

## 2026-09-20 20:19 CT — ChatGPT passive-seed runtime validation hardening

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/src/ofxp/discovery.ts` and `packages/opencode/test/ofxp/discovery.test.ts` only.
- **Invariant:** malformed passive-provider metadata must be dropped at the discovery boundary and must never throw merely because a decoded addresses array contains a non-string element.
- **Planned change:** make address normalization accept unknown elements and filter non-strings; add focused malformed-seed regression. No runtime/provider integration.

## 2026-09-20 20:21 CT — ChatGPT passive-seed runtime validation DONE

- **Status:** DONE; releasing the discovery source/test files again.
- **Changes made:** passive seed address normalization now accepts unknown array elements and drops non-string/malformed entries instead of throwing.
- **Verification performed:** discovery suite remains 8/8, now 32 assertions including malformed mixed-type address input; scoped production compilation has no target discovery/runtime diagnostics and only the existing unrelated repository errors.

## 2026-09-20 20:24 CT — ChatGPT public-root wire privacy regression lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/test/ofxp/capability.test.ts` only; production capability/root/schema files remain read-only.
- **Invariant:** `root.list` may expose only public root identity/alias metadata. Canonical host paths and identity fingerprints must remain local and never serialize onto the OFXP wire.
- **Verification target:** extend the existing transport-backed capability test with explicit no-host-path/no-internal-field assertions on the decoded root list.

## 2026-09-20 20:27 CT — ChatGPT public-root wire privacy regression DONE

- **Status:** DONE; releasing `packages/opencode/test/ofxp/capability.test.ts`.
- **Changes made:** added explicit `root.list` assertions that the canonical host path is absent and the public root object contains only alias/approvedAt/available/id/source. Also refreshed one stale capability-list expectation to include the already-registered `refactor` capability.
- **Verification performed:** transport-backed capability suite passes 18/18 with 229 assertions. Existing path-redaction checks for read/find/project/symbols remain green.
- **Production changes:** none.

## 2026-09-20 20:30 CT — ChatGPT pairing rate-limit primitive lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** new `packages/opencode/src/ofxp/pair-rate-limit.ts` and new `packages/opencode/test/ofxp/pair-rate-limit.test.ts` only. `transport.ts` remains owned by the 18:59 re-key lane.
- **Objective:** provide a tested network-source rate limiter that cannot be bypassed by rotating attacker-controlled pre-pairing peer identities.
- **Invariant:** per-source accounting keys only on normalized remote network address; IPv4-mapped IPv6 converges with IPv4; missing addresses share one fail-safe bucket; the process-global cap is independent; source memory is hard-bounded.
- **Handoff/request:** active transport owner should replace its private limiter/sourceKey with this primitive once ready; no transport edit from this lane.

## 2026-09-20 20:34 CT — ChatGPT pairing rate-limit primitive DONE

- **Status:** DONE; releasing `packages/opencode/src/ofxp/pair-rate-limit.ts` and `packages/opencode/test/ofxp/pair-rate-limit.test.ts`.
- **Changes made:** added a transport-independent `PairRateLimiter` keyed solely by normalized remote network address, including IPv4-mapped IPv6 convergence, a shared fail-safe `unknown` bucket, independent process-global cap, deterministic window reset, and hard-bounded/LRU source memory.
- **Verification performed:** canonical package harness (`bun test --timeout 30000`) passes 6/6 with 120 assertions; source-only typecheck reports 0 diagnostics. The earlier 5-second unnamed hook failure was the package preload's Windows teardown exceeding Bun's default hook timeout, not a limiter/test leak.
- **Handoff/request:** replace the private limiter in `ofxp/transport.ts` with this primitive and pass only `socket.remoteAddress`; do not include pre-pairing peer identity in the network-source key.

## 2026-09-20 20:37 CT — ChatGPT identity-rotation policy primitive lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** new `packages/opencode/src/ofxp/rotation-policy.ts` and new `packages/opencode/test/ofxp/rotation-policy.test.ts` only. `runtime.ts`, API schema/handlers, UI, and Core identity store remain with the active re-key owner.
- **Objective:** encode the corrected lifecycle/fencing contract as a deterministic pure policy the runtime can apply inside its existing `SynchronizedRef` critical section.
- **Invariant:** mutations must target the exact displayed current peer ID; an unexpired continuity proof cannot be revoked by local finalization, so neither finalize nor another rotation may proceed until its cryptographic expiry; an expired-but-unfinalized journal must still be explicitly finalized before another rotation.
- **Handoff/request:** runtime/API owner should map policy conflicts to typed HTTP 409 and reconcile Settings state on mismatch; no runtime edit from this lane.

## 2026-09-20 20:40 CT — ChatGPT truthful remote root availability lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/src/ofxp/capability.ts` and focused `root.list` assertions in `packages/opencode/test/ofxp/capability.test.ts` only. Core peer/root storage, Settings projection, schema, runtime, and re-key files remain untouched.
- **Objective:** make the wire-level `PublicRoot.available` field truthful. Settings correctly stopped projecting fake availability, but remote `root.list` still receives Core's durable placeholder `available: true` even if an approved root disappeared or was replaced.
- **Invariant:** canonical paths/fingerprints remain local; availability is derived on demand by revalidating each approved root through the existing `OfxpRoot.verify` boundary. This is bounded to the already-capped 128 roots and runs only on explicit remote `root.list`, not the 5-second Settings poll.

## 2026-09-20 20:43 CT — ChatGPT truthful remote root availability BLOCKED / released

- **Status:** BLOCKED; releasing `capability.ts` / capability test without edits.
- **Finding:** `OfxpRoot.verify` correctly revalidates canonical path + identity fingerprint, but it requires an internal `Authorization` containing canonical root state. `peers.roots()` intentionally returns only redacted `PublicRoot`, while `peers.authorize()` also enforces a capability grant and therefore is not a valid generic root-liveness probe. Reconstructing canonical paths in the capability adapter would violate ownership/privacy.
- **Owner-first requirement:** add a narrow Core/OfxpRoot owner API that can batch/project public roots with truthful liveness without exposing canonical paths (or remove `available` from the public wire schema if callers do not require it). Core peer files/schema are currently inside the active re-key claim, so no competing change is safe now.
- **Safety note:** this is correctness/UX metadata, not an authorization bypass. Every actual filesystem operation already calls the canonical root verification boundary and fails closed if the root moved/disappeared/replaced.

## 2026-09-20 20:45 CT — ChatGPT observability architecture gap

- **Files claimed:** none; read-only normative audit.
- **Normative plan:** §24 requires bounded process-global OFXP metrics including discovery/trusted/online peer counts, pairing attempts/failures/rate limits, connection opened/reused/failed, invocation outcomes, authority denials, identity mismatches, ambiguous mutations, worker starts, and peer-message counters, without Session hydration.
- **Live finding:** no OFXP metrics owner/counter surface exists under `packages/opencode/src/ofxp`, and the named normative counters are absent repository-wide. Activity projection is implemented, but it is not a substitute for process-global operational/security metrics.
- **Scope:** this is an observability/completeness gap rather than a Settings authority blocker. Implement as one bounded process-global metrics owner fed by existing runtime/transport/capability commit points; do not add per-peer timers or Session-history scans.

## 2026-09-20 20:46 CT — ChatGPT bounded OFXP metrics primitive lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** new `packages/opencode/src/ofxp/metrics.ts` and new `packages/opencode/test/ofxp/metrics.test.ts` only. Runtime/transport/capability/activity/UI remain with current owners.
- **Objective:** encode §24's process-global bounded metric vocabulary in one dependency-free owner so hot-path owners can increment/set counters without per-peer maps, timers, Session hydration, or payload retention.
- **Invariant:** snapshots contain numbers only; counters saturate at `Number.MAX_SAFE_INTEGER`, gauges clamp to non-negative safe integers, reset is explicit/test-only-friendly, and no peer/session/path/payload identifiers are retained.

## 2026-09-20 20:49 CT — ChatGPT bounded OFXP metrics primitive DONE

- **Status:** DONE; releasing `packages/opencode/src/ofxp/metrics.ts` and `packages/opencode/test/ofxp/metrics.test.ts`.
- **Changes made:** added one O(1) process-global metrics owner covering the normative peer gauges, pairing/connection counters, per-plane invocation counts, failures/denials/mismatches/ambiguous mutations, worker starts, and peer-message counters. It retains no identifiers or payloads, clamps gauges, saturates counters, returns detached snapshots, and has explicit reset.
- **Verification performed:** focused metrics suite passes 3/3 with 10 assertions; source-only typecheck reports 0 diagnostics.
- **Remaining integration:** runtime/transport/capability/messaging owners should feed this singleton only at existing authoritative commit/admission points. Do not create per-peer metric owners or derive these by polling Settings/Session history.

## 2026-09-20 20:40 CT — ChatGPT identity-rotation policy primitive DONE

- **Status:** DONE; releasing `packages/opencode/src/ofxp/rotation-policy.ts` and `packages/opencode/test/ofxp/rotation-policy.test.ts`.
- **Changes made:** added pure `canRotateIdentity` / `canFinalizeIdentityRotation` policy with exact-current-peer fencing, active-proof overlap rejection, expired-but-unfinalized rotation blocking, and idempotent no-journal finalization semantics.
- **Verification performed:** focused policy suite passes 5/5 with 8 assertions; source-only typecheck reports 0 diagnostics.
- **Handoff/request:** integrate these checks inside the runtime's existing synchronized mutation critical sections, expose `expectedPeerID` in rotate/finalize operator payloads, and map policy conflicts to HTTP 409 before listener teardown or durable identity mutation.

## 2026-09-20 20:44 CT — ChatGPT unresolved re-key hardening takeover

- **Status:** CLAIMED / WORKING; this supersedes the stale 18:59 implementation claim for the unresolved blocker paths below.
- **Coordination basis:** no newer root-ledger owner exists for these files; `project recent` shows the re-key implementation surfaces idle for roughly 1–2 hours; the OFXP ledger has no owner progress after the 19:22 UI expansion; user explicitly requested comprehensive continuation. Any original owner resuming must treat this entry as authoritative and avoid these exact files until release.
- **Files claimed:** `packages/opencode/src/ofxp/runtime.ts`, `packages/opencode/src/ofxp/transport.ts`, focused runtime/transport tests, `packages/core/src/ofxp-peer/index.ts`, `packages/core/src/ofxp-peer/pairing.ts`, focused peer/pairing tests, `packages/opencode/src/server/routes/instance/httpapi/groups/ofxp.ts`, `packages/opencode/src/server/routes/instance/httpapi/handlers/ofxp.ts`, `packages/app/src/components/settings-v2/ofxp-network.tsx`, OFXP-only English i18n edits, generated OFXP SDK surfaces/contract test as required, and `packages/schema/src/ofxp.ts` only if the operator contract requires it.
- **Blockers being closed:** (1) trusted-peer fresh-SAS re-verification reachability; (2) early-finalization overlap; (3) stale rotate/finalize generation fencing; (4) stale revoke/root-add authority-generation fencing; (5) pending SAS surviving revoke; (6) per-source pairing limiter bypass. Discovery fallback remains a separate producer/runtime lane after these security blockers are green.
- **Invariants:** all destructive/authority-adding mutations are server-side fenced; active continuity proof cannot be revoked locally before expiry; revoke is a hard trust-generation boundary; fresh SAS never auto-transfers grants/roots; public pairing source limits use transport-derived network address only; no renderer cryptography; no workspace bootstrap.

## 2026-09-20 20:52 CT — ChatGPT discovery stale-candidate eviction lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/src/ofxp/discovery.ts` and `packages/opencode/test/ofxp/discovery.test.ts` only; runtime remains owned by re-key hardening.
- **Normative invariant:** §25 requires TTL/LRU/bounded candidate state without per-candidate timers. The directory is already bounded/LRU-ish by `seenAt`, but passive provider hints need an explicit global-sweep eviction primitive so a missed/down producer event cannot live forever.
- **Planned change:** add one deterministic `expireOlderThan(cutoff)` directory operation that removes stale entries across all providers in one bounded scan and emits at most one change notification. No timers or runtime wiring in this lane.

## 2026-09-20 20:54 CT — ChatGPT discovery stale-candidate eviction DONE

- **Status:** DONE; releasing discovery source/test files.
- **Changes made:** Directory now exposes `expireOlderThan(cutoff)` for one bounded process-global stale-observation sweep across mDNS/known/server providers. It emits at most once per sweep and allocates no candidate timers/reconnect loops.
- **Verification performed:** discovery suite passes 9/9 with 39 assertions; source-only typecheck reports 0 diagnostics.
- **Remaining integration:** when alternate discovery producers are wired, runtime should drive this from one coarse process-global cadence or producer refresh boundary; do not create per-peer TTL timers.

## 2026-09-20 20:56 CT — ChatGPT model/operator boundary regression lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** new `packages/opencode/test/ofxp/tool-operator-boundary.test.ts` only. Model tool/runtime/operator Settings implementation remains read-only.
- **Normative invariant:** §23.4/§25 require pairing, trust/grant/root mutation, revoke/re-key, and runtime lifecycle to remain operator-only and absent from the model-facing OFXP tool schema.
- **Verification target:** decode-level regression proving only status/peers/roots/list/describe/call/receipt are accepted and representative operator actions are rejected by the actual exported tool Parameters schema.

## 2026-09-20 20:58 CT — ChatGPT model/operator boundary regression DONE

- **Status:** DONE; releasing the new test file.
- **Verification performed:** focused suite passes 2/2 with 16 assertions against the actual exported `Parameters` schema. The seven model actions decode; pair/trust/grant/root approval/revoke/re-key/identity rotation/start/stop are rejected at schema decode before tool execution.
- **Production changes:** none.

## 2026-09-20 21:00 CT — ChatGPT disable teardown fail-open review

- **Files claimed:** none; runtime is owned by the 20:44 re-key hardening lane.
- **Invariant:** §26.1 requires disabling OFXP to tear down listener/advertisement/browser/connection pool/pending non-durable work convergently; Settings must not report disabled while a failed listener teardown is silently ignored.
- **Finding:** `closeActiveStrict()` correctly surfaces endpoint-stop failure, but ordinary `stop()` calls `closeActive()`, which catches and discards every strict teardown error after moving the synchronized state to `inactive`. `setEnabled(false)` persists disabled intent and then calls that swallowing `stop()`. If endpoint teardown ever rejects, operator state can therefore report disabled while the previous listener/resource may still be live and the runtime has discarded its `Active` handle needed for retry.
- **Recommended fix:** make the operator disable path strict/convergent: do not irreversibly publish `inactive` until authoritative listener/connection teardown succeeds, or retain a closing/error state/handle that can be retried. Discovery stop may remain advisory, but dedicated listener teardown must not be silently forgotten. Preserve the existing preference rollback/transaction semantics around failures.
- **Required regression:** inject endpoint/connection stop failure and prove disable does not return a false inactive success or lose the live handle; retry must converge to inactive after teardown succeeds.

## 2026-09-20 21:02 CT — ChatGPT connection-pool convergent teardown lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/src/ofxp/connection-manager.ts` and `packages/opencode/test/ofxp/connection-manager.test.ts` only. Runtime/transport remain owned by re-key hardening.
- **Concrete defects:** an in-flight connector can resolve after `stop()` sets `stopped` and currently inserts a fresh active row because there is no post-connect stopped check; `stop()` returns without awaiting pending dials; active rows are cleared before close and close failures are swallowed, losing retry ownership.
- **Invariant:** once stop begins, no new pooled connection may publish; stop waits bounded connector settlement, closes every resulting active row, removes only successfully closed rows, and surfaces failures so a retry can converge. `closePeer` likewise must not discard a failed-close handle.

## 2026-09-20 21:06 CT — ChatGPT connection-pool convergent teardown DONE

- **Status:** DONE; releasing connection-manager source/test.
- **Changes made:** added a post-connect stopped fence so late dials are closed before publication; `stop()` now waits all already-owned dials, closes active rows, removes only successful closes, and surfaces aggregate close failures while retaining failed rows for retry; `closePeer()` likewise preserves failed-close ownership and surfaces the failure.
- **Verification performed:** connection-manager suite passes 9/9 with 32 assertions, including late-dial stop convergence and failed-close retry. Scoped compiler reports no diagnostic in connection-manager itself; remaining diagnostics are existing Node-type/transport dependency-environment errors.
- **Handoff/request:** runtime owner should use strict pool teardown rather than swallowing it, so operator disable can retain/retry the Active state on failure instead of falsely publishing inactive.

## 2026-09-20 21:08 CT — ChatGPT Settings lazy-capability regression lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/app/src/components/settings-v2/ofxp-network-architecture.test.ts` only; production Settings/runtime remain read-only.
- **Normative invariant:** §26.1 says opening Settings must not hydrate remote capability catalogs. The compact Settings endpoint owns only Tier-0/1 state; capability list/describe/call/receipt belong to explicit model/data-plane actions.
- **Verification target:** source architecture assertions that the Settings component uses only the scoped `client.ofxp` Settings API and contains no capability/list/describe/call/receipt or model-tool invocation path.

## 2026-09-20 21:09 CT — ChatGPT Settings lazy-capability regression DONE

- **Status:** DONE; releasing the architecture test again.
- **Verification performed:** canonical app Solid/happydom harness passes 2/2 with 24 assertions. In addition to scoped-server/zero-workspace fencing, the test now rejects model-tool imports and capability/describe/receipt/call client paths from the Settings component.
- **Production changes:** none.

## 2026-09-20 21:11 CT — ChatGPT released-lane integration matrix

- **Files claimed:** none; verification-only across released lanes while re-key takeover continues separately.
- **Verification performed:** opencode released-lane matrix passes 23/23 with 97 assertions across discovery, connection-manager, bounded metrics, and model/operator boundary. App architecture/passive-store matrix passes 11/11 with 84 assertions across OFXP scoped-server architecture, Servers/OFXP separation, and bootstrap:false child-store behavior.
- **Note:** the first batched shell's second command used a cwd-relative path after command 1 changed directory and therefore did not execute; the app matrix was immediately rerun from the explicit app workdir and passed cleanly. No code failure was hidden by that harness invocation mistake.

## 2026-09-20 21:13 CT — ChatGPT connection metrics integration lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/src/ofxp/connection-manager.ts` and its focused test only. Runtime/transport remain with re-key hardening; metrics primitive is released.
- **Objective:** wire the first authoritative §24 commit points: successful pooled connection publication, pooled reuse, and terminal dial failure. Use the O(1) metrics owner; no endpoint/peer labels or per-peer metric state.
- **Testing seam:** constructor receives an optional metrics owner defaulting to the process-global singleton so focused tests can assert counters without global cross-test contamination.

## 2026-09-20 21:15 CT — ChatGPT connection metrics integration DONE

- **Status:** DONE; releasing connection-manager source/test again.
- **Changes made:** connection manager now increments aggregate `connectionsOpened` only after authenticated pooled publication, `connectionsReused` on actual open-pool reuse, and `connectionsFailed` once after terminal endpoint exhaustion. Stop-driven dial cancellation is not miscounted as a network failure. No peer/endpoint labels are retained.
- **Verification performed:** connection-manager suite passes 10/10 with 36 assertions including isolated local metrics assertions. Scoped compiler has no diagnostics in metrics/connection-manager; reported diagnostics remain the existing Node-type/transport dependency environment issues.

## 2026-09-20 21:16 CT — ChatGPT discovery gauge integration lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** discovery source/test only; runtime remains with re-key hardening.
- **Objective:** feed the authoritative bounded directory candidate cardinality into the process-global `discoveryCandidates` gauge on every successful add/remove/expiry/clear, without polling or per-peer state outside the directory.

## 2026-09-20 21:18 CT — ChatGPT discovery gauge integration DONE

- **Status:** DONE; releasing discovery source/test again.
- **Changes made:** Directory now updates the aggregate `discoveryCandidates` gauge from its own bounded authoritative entries whenever a mutation emits. Multiple endpoints/providers for one peer count once; clear returns the gauge to zero. No identifiers are retained by metrics.
- **Verification performed:** discovery suite passes 10/10 with 43 assertions; discovery+metrics source typecheck reports 0 diagnostics.

## 2026-09-20 21:20 CT — ChatGPT cross-process identity convergence defect

- **Files claimed:** none; identity store/runtime are owned by the active re-key hardening lane.
- **Invariant:** atomic cross-process identity rotation is not complete if sibling processes sharing the durable identity can continue accepting TLS as the superseded key indefinitely after another process wins the CAS.
- **Live finding:** FileStore replacement is correctly lock/CAS protected, but Store/RotatableStore expose only read/write/replace—no change notification/watch/generation signal. Runtime loads the durable identity only in `openActive()` and never re-reads it during normal active lifetime. Therefore process A can rotate durable A→B while process B, already active from the same identity file, continues listening/advertising A until independently stopped/restarted. The local rotate path's “old listener stops before durable publication” guarantee applies only to the winning process.
- **Impact:** this is not an automatic authority transfer, but it breaks one-authoritative-local-identity convergence and can leave peers seeing/connecting to a superseded identity after durable rotation. It also makes continuity/finalization semantics process-local despite cross-process CAS storage.
- **Required architecture:** add one process-global identity-generation convergence mechanism for FileStore users (bounded file watch/poll or owner IPC), and on external generation change stop the superseded listener/advertisement/connection pool before reopening as the durable current identity. Do not add per-peer timers. A sibling that observes an unsupported/invalid transition must fail closed rather than keep serving the stale key.
- **Required regression:** start two runtimes/stores against one durable identity, rotate in one, and prove the sibling ceases serving the old peer ID and converges to the new durable identity without a manual restart.

## 2026-09-20 21:22 CT — ChatGPT cross-process authority invalidation defect

- **Files claimed:** none; Core peer/process/runtime surfaces overlap active re-key work.
- **Invariant:** revocation/grant/root generation changes must retire already-running remote authority even when the durable mutation is committed by a sibling OpenFork process sharing the same state/database.
- **Live finding:** `OfxpPeer.subscribe()` is an in-memory `Set<listener>` notified only by mutations executed through that Service instance. `OfxpProcessCapability` relies on that local callback to retire owned background process handles when peer/grant/root authority changes. A mutation committed by process A therefore does not notify process B; B's already-running remote process can continue until another local event/operation causes revalidation or the process exits. New invocations still query durable authority and fail closed, but existing background work is not convergently retired cross-process.
- **Impact:** this is stronger than the stale-socket issue: previously admitted long-running process authority can outlive an externally committed revoke/grant reduction. Cross-process identity CAS proves sibling processes are in scope, so in-process-only invalidation is insufficient as the final authority boundary.
- **Required architecture:** add a bounded process-global durable authority-generation/change feed (SQLite change journal/generation counter, owner IPC, or equivalent) consumed by each OFXP process. On observed peer/grant/root generation change, reuse the existing local notification/retirement path. No per-peer polling; one coarse process-global owner is acceptable.
- **Required regression:** two peer-service/process-capability instances over one durable DB; start remote background work through B, revoke or reduce authority through A, and prove B retires the handle without a new remote request.

## 2026-09-20 21:24 CT — ChatGPT live re-key runtime checkpoint

- **Files claimed:** none; active re-key hardening owner retains implementation.
- **Verification performed on current live tree:** focused runtime suite passes 9/9 with 73 assertions, including durable rotation/restart continuity, no trust mutation before fresh SAS, non-rotatable-store fail-closed behavior, CAS-loser convergence, exact-peer generation fencing, and proof-expiry + explicit-finalization policy.
- **Still outside this green checkpoint:** operator HTTP/SDK/UI propagation, transport source limiter replacement, strict disable teardown failure semantics, and the separately logged passive sibling-process convergence gaps.

## 2026-09-20 21:25 CT — ChatGPT live trust-generation checkpoint

- **Files claimed:** none; verification-only against the active owner's live Core changes.
- **Verification performed:** Core pairing + peer suites pass 26/26 with 102 assertions. New hardening is green for peer-scoped pending-ceremony cancellation, single-use/replay/TTL/bounds, stale fenced revoke after revoke→repair, stale root approval after revoke→repair, deny-by-default re-pair, live grant/root/re-key admission, and bidirectional pairing with independent directional authority.
- **Result:** the previously logged stale revoke/root-add and pre-revoke pending-SAS defects are now covered by passing Core regressions on the live tree. HTTP/UI callers still need to propagate the generation fences before those issues are closed end-to-end.

## 2026-09-20 21:26 CT — ChatGPT live transport hardening checkpoint

- **Files claimed:** none; verification-only against active re-key transport changes.
- **Verification performed:** transport suite passes 6/6 with 24 assertions. The transport now imports the released network-address `PairRateLimiter`; the old peer-ID-derived source key/private limiter is gone. Regression proves one network source remains rate-limited even while rotating pre-pairing identities, alongside TLS peer binding, bidirectionality, wrong-peer fail-closed behavior, pairing/TLS identity binding, and cancellation propagation.
- **Result:** the per-source pairing limiter bypass logged at 19:59 is closed at the transport layer on the live tree.

## 2026-09-20 21:27 CT — ChatGPT root-fence adapter checkpoint

- **Files claimed:** none; active re-key owner retains root/API integration.
- **Live partial-state note:** Core `approveRoot` now accepts/checks `expectedGrantRevision`, and the Core stale-root regression is green. `OfxpRoot.Interface.approve` currently lists `StaleRevisionError` in its error channel but its call signature/implementation still does not accept or forward an expected revision to Core. This appears to be an in-progress adapter step, not a new competing claim.
- **Required end-to-end shape:** operator root-add payload → handler → `OfxpRoot.approve(... expectedGrantRevision ...)` → Core `approveRoot` transaction. Do not infer the revision inside the adapter; it must be the revision the operator actually viewed so stale requests receive 409.

## 2026-09-20 21:28 CT — ChatGPT BLOCKER: root handler currently bypasses canonical root owner

- **Files claimed:** none; active re-key owner is editing this handler/root path now.
- **Live partial-state defect:** current `handlers/ofxp.ts` rootAdd forwards the operator-supplied `canonicalPath` directly to `peers.approveRoot(...)` to carry `expectedGrantRevision`. That bypasses `OfxpRoot.approve` entirely and therefore bypasses absolute-path validation, UNC/filesystem-root rejection, `realPath()` canonicalization, directory existence/type checks, alias normalization, and filesystem identity fingerprint capture.
- **Severity:** authority/security blocker if left this way. A stale-fence fix must not weaken the root authorization boundary.
- **Required fix:** extend `OfxpRoot.approve` to accept `expectedGrantRevision` and forward it only after all existing canonicalization/fingerprint validation; handler must call that root owner, never Core peer storage directly with renderer-supplied path text. Add HTTP regression for invalid/nonexistent/root/escaping-style candidates plus stale revision 409 so both validation and fencing are proven together.

## 2026-09-20 21:31 CT — ChatGPT root-owner fencing adapter lane

- **Status:** CLAIMED / WORKING for `packages/opencode/src/ofxp/root.ts` and `packages/opencode/test/ofxp/root.test.ts` only. These files are not listed in the 20:44 takeover claim and have been idle while handler/API work proceeds; handler remains owned by that lane.
- **Objective:** extend the canonical root owner with optional `expectedGrantRevision` and prove it performs all filesystem/canonical/fingerprint validation before forwarding the fence to Core. This gives the handler owner a safe API to replace its temporary direct peer-storage call.

## 2026-09-20 21:34 CT — ChatGPT root-owner fencing adapter DONE

- **Status:** DONE; releasing `ofxp/root.ts` and root test.
- **Changes made:** `OfxpRoot.approve` now accepts optional `expectedGrantRevision` as its fifth argument and forwards it to Core only after the existing absolute/root/UNC/realpath/directory/fingerprint/alias validation boundary succeeds.
- **Verification performed:** root suite passes 4/4 with 11 assertions. New regression proves a nonexistent candidate returns `OfxpRoot.InvalidPathError` even with a stale fence, an existing valid candidate with stale revision returns `OfxpPeer.StaleRevisionError`, and the current revision approves normally. Scoped compiler has no root diagnostic; only the existing `bun:sqlite` environment resolution diagnostic remains.
- **Immediate handoff:** handler owner should replace the temporary direct `peers.approveRoot` call with `roots.approve(params.peerID, payload.canonicalPath, payload.alias, payload.source ?? "manual", payload.expectedRevision)` and preserve `rootError` mapping.

## 2026-09-20 21:36 CT — ChatGPT root handler blocker still live after handler edit

- **Read-back:** latest handler still calls `peers.approveRoot({ canonicalPath: payload.canonicalPath, ... })` directly at the operator rootAdd boundary. The safe fenced `OfxpRoot.approve(..., expectedGrantRevision)` adapter is now implemented and green, so there is no remaining reason to bypass it.
- **Do not close the re-key/API lane** until rootAdd is switched to the root owner and the HTTP test proves both stale 409 and canonical filesystem validation. `peerError(..., "ofxp_stale_root")` alone does not restore the skipped path/fingerprint checks.

## 2026-09-20 21:37 CT — ChatGPT live Tier-0 test checkpoint (one test-harness defect)

- **Files claimed:** none; active API owner is currently editing the Tier-0 regression.
- **Verification performed:** current `httpapi-tier0-ownership.test.ts` runs 15/16 green. The new stale revoke/root-generation test fails before issuing HTTP because it calls nonexistent `HttpClientRequest.del(...)` at line ~505.
- **Repair:** repository Effect HTTP tests use `HttpClientRequest.delete(...)` (for example `httpapi-pty.test.ts`). Replace `del` with `delete`, then rerun. This failure says nothing about the OFXP endpoint yet because no request reached it.

## 2026-09-20 21:39 CT — ChatGPT Tier-0 stale-generation regression green

- **Change made:** corrected the focused test-only `HttpClientRequest.del` typo to the repository's `HttpClientRequest.delete` API; no production surface touched.
- **Verification performed:** Tier-0 ownership suite now passes 16/16 with 48 assertions, including identity generation 409, stale grant 409, and stale revoke/root generation 409 while retaining zero-workspace ownership.
- **Important limitation:** this green stale-root test does not exercise canonical root validation. The live rootAdd handler still bypasses `OfxpRoot.approve`; the 21:28/21:36 security blocker remains open until the handler uses the validated root owner.

## 2026-09-20 21:40 CT — ChatGPT narrow rootAdd security integration takeover

- **Status:** CLAIMED / WORKING for only the `OfxpRoot` import/service acquisition and `rootAdd` handler hunk in `handlers/ofxp.ts`; the broader 20:44 API owner retains every other handler/API/UI hunk.
- **Coordination basis:** the canonical fenced root adapter is green, the direct-storage bypass has remained live through multiple handler/test edits, and leaving it in place is an authority-boundary regression. This narrow claim supersedes only that exact hunk; concurrent owner must not rewrite rootAdd until this entry is released.

## 2026-09-20 21:41 CT — ChatGPT rootAdd dependency wiring extension

- **Scope extension:** narrow claim also includes only the `OfxpRoot` import + `OfxpRoot.node` entry in `server.ts`, required because the canonical root owner is now a direct Tier-0 handler dependency. First verification after switching rootAdd failed 0/16 with `Service not found: @opencode/OfxpRoot`; no endpoint assertion ran.
- **Invariant:** this is still Tier-0/global ownership—`OfxpRoot.node` depends on FS + durable peer state, not workspace Instance bootstrap.

## 2026-09-20 21:42 CT — ChatGPT Tier-0 root service test wiring

- **Scope extension:** focused Tier-0 test also needs an explicit `OfxpRoot.Service` mock because its negative ownership layer intentionally assembles handlers directly rather than using production `server.ts`. Production app wiring alone cannot satisfy that test harness.
- **Testing contract:** mock root approval returns stale revision based on the operator fence; canonical filesystem validation itself remains proven by the real `ofxp/root.test.ts` suite, while the HTTP test proves the handler depends on the root owner and maps stale fence to 409.

## 2026-09-20 21:45 CT — ChatGPT rootAdd security integration DONE / released

- **Status:** DONE; releasing the narrow handler/server/test hunk back to the 20:44 owner.
- **Production fix:** rootAdd now calls the canonical `OfxpRoot.approve(... expectedGrantRevision)` owner rather than writing renderer path text directly through peer storage. Production server node graph now explicitly provides `OfxpRoot.node` as the handler dependency.
- **Test wiring:** Tier-0 negative-ownership harness provides an explicit root-service mock (it intentionally does not use the production server graph). Tier-0 suite passes 16/16 with 48 assertions; real root suite separately passes 4/4 with 11 assertions proving validation-before-fence and canonical owner behavior.
- **Compiler:** scoped root/handler/server compile reports no diagnostics in these target files; remaining diagnostics are the pre-existing filesystem/skill/WASM/seek-bzip repository issues.
- **Security result:** the direct canonical-path storage bypass logged at 21:28 is closed.

## 2026-09-20 21:46 CT — ChatGPT root ownership architecture regression lane

- **Status:** CLAIMED / WORKING for new `packages/opencode/test/ofxp/root-http-architecture.test.ts` only.
- **Invariant:** future optimistic-fencing refactors must never bypass `OfxpRoot` and write operator path text directly through `OfxpPeer.approveRoot` from the HTTP adapter.
- **Verification target:** source ownership regression locking root-service import/acquisition and rootAdd delegation while rejecting direct peer-storage approval in the handler.

## 2026-09-20 21:47 CT — ChatGPT root ownership architecture regression DONE

- **Status:** DONE; releasing new test.
- **Verification performed:** focused architecture regression passes 1/1 with 6 assertions. It requires root-service import/acquisition, expected revision forwarding in rootAdd, and explicitly rejects `peers.approveRoot` inside the HTTP rootAdd hunk.

## 2026-09-20 21:56 CT — ChatGPT cross-process identity observation primitive lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/core/src/ofxp-peer/identity-store.ts` and `packages/core/test/ofxp-identity-store.test.ts` only. Runtime remains read-only until the store primitive is green.
- **Objective:** give durable FileStore identities one bounded cross-process generation signal resilient to atomic rename replacement on Windows/POSIX.
- **Invariant:** exactly one local-identity watcher per active runtime, never per peer; watcher stores no key material, invokes only on stat-generation change, and supports deterministic disposal. The consumer must re-read/validate durable identity before acting; watcher events themselves carry zero trust/key data.
- **Implementation direction:** `watchFile` on the exact identity path with a bounded interval plus immediate consumer-side durable re-read. This avoids inode-bound directory-watch gaps across rename replacement while remaining process-global/O(1).

## 2026-09-20 21:59 CT — ChatGPT cross-process identity observation primitive DONE

- **Status:** DONE; releasing identity-store source/test.
- **Changes made:** FileStore now implements a keyless generation watcher using one `watchFile` stat poll on the exact identity path; `supportsWatch()` exposes the optional capability. Events carry no key/identity payload and disposal is idempotent.
- **Verification performed:** identity-store suite passes 8/8 with 27 assertions, including atomic replacement observation and disposal. Scoped compiler remains dominated by the repository's existing missing Node ambient-type environment; focused runtime tests execute the code successfully.
- **Handoff:** runtime must re-read/validate durable state on each event and compare against its active key; watcher notification itself is never authority.

## 2026-09-20 22:00 CT — ChatGPT cross-process identity runtime convergence lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/opencode/src/ofxp/runtime.ts` and focused `packages/opencode/test/ofxp/runtime.test.ts` only.
- **Objective:** an active FileStore-backed runtime automatically converges when a sibling process atomically rotates the shared durable identity.
- **Invariant:** external generation change never mutates trust directly; runtime re-reads and validates the durable record, stops the superseded listener/advertisement/pool before reopening, preserves host/port/discovery configuration, and fails closed rather than continuing to serve a stale key if durable state cannot be validated.

## 2026-09-20 22:08 CT — ChatGPT cross-process identity runtime convergence DONE

- **Status:** DONE; releasing runtime/test identity-convergence hunks.
- **Production changes:** active FileStore runtimes now own one path-based identity watcher outside `openActive`/state mutation. External durable generation changes are re-read and cryptographically validated, the superseded mDNS/listener/connection pool is retired strictly, and the runtime reopens under the durable replacement on the same host/port when possible. Invalid durable replacement fails closed instead of continuing to serve the stale key.
- **Lifecycle hardening:** runtime `stop()` now surfaces strict teardown failures and only publishes inactive after listener/pool teardown succeeds; `setEnabled(false)` rolls the persisted enabled preference back if strict teardown fails.
- **Verification performed:** full runtime suite passes 10/10 with 79 assertions. New live-clock FileStore regression externally rotates the shared identity from a sibling store and proves automatic old->new peer convergence while preserving the listener port. Identity-store suite separately passes 8/8 with 27 assertions.
- **Testing note:** the first version of the new regression used the harness TestClock with `Effect.sleep`, causing a false timeout after production convergence had already logged; switching this filesystem/watch test to the harness live clock resolved that test-only issue.

## 2026-09-20 22:12 CT — ChatGPT cross-process authority generation lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/core/src/ofxp-peer/sql.ts`, authority-generation hunks in `packages/core/src/ofxp-peer/index.ts`, focused Core peer tests, and canonical generated migration/schema artifacts produced by `packages/core/script/migration.ts`. Runtime/process consumers remain read-only until the Core feed is green.
- **Objective:** make durable trust/grant/root reductions visible to sibling OpenFork processes so already-running remote authority cannot outlive a mutation performed through another process.
- **Storage design:** add one `authority_epoch` integer to each durable peer row. Every authority-affecting mutation increments that peer's epoch atomically with its durable mutation. No append-only journal exists, so storage remains O(peers), not O(mutations).
- **Observer design:** each process maintains one bounded peer->epoch snapshot and one coarse process-global poll only while there are subscribers. Each pass is one batched `peer id + authority_epoch` read; changed epochs emit one generic `authority-changed` event. No per-peer timers, workspace Instances, history hydration, endpoints, or payloads.
- **Mutation coverage:** trust/re-pair, re-key trust old+new identities, revoke/revokeFenced, requireRekey, grant replacement, root add/update, and root removal increment epochs. `markSeen` explicitly does not.

## 2026-09-20 22:27 CT — ChatGPT cross-process authority generation Core DONE

- **Status:** DONE for Core storage/feed; releasing Core peer/schema/migration/test claims. Consumer retirement wiring remains a separate lane.
- **Production changes:** `ofxp_peer.authority_epoch` is durable and bounded O(peers). Trust/re-pair, re-key old+new identities, revoke/fenced revoke, require-rekey, grant replacement, root upsert, and root removal advance the peer epoch atomically with the authority mutation; `markSeen` does not. Grant replacement is now one IMMEDIATE transaction with the peer-state check + optimistic grant CAS + epoch bump.
- **Observer:** `OfxpPeer.syncExternalChanges()` performs one batched `peer id + authority_epoch` read. `subscribe()` owns one unref'd 250ms process-global poll only while listeners exist; changes emit generic `authority-changed`. No per-peer timers, append-only journal, workspace Instance, path, endpoint, capability payload, or history hydration is involved.
- **Migration:** canonical generator produced `20260921032422_ofxp_peer_authority_epoch.ts`, adding `authority_epoch integer DEFAULT 0 NOT NULL`; generated schema/snapshot/registry were updated by the guarded generator.
- **Verification performed:** full `ofxp-peer.test.ts` passes 17/17 with 91 assertions. New file-backed regression keeps two independently built peer services alive against one SQLite WAL file and proves B observes trust, grant, root add/remove, and fenced revoke as external authority generations while `markSeen` yields zero invalidation. Scoped Core compile has no OFXP diagnostic; remaining diagnostics are existing `bun:sqlite` / unrelated `TextDecoder` environment issues.

## 2026-09-20 22:28 CT — ChatGPT authority-generation consumer retirement lane

- **Status:** CLAIMED / WORKING.
- **Initial scope:** inspect and minimally update every `OfxpPeer.subscribe` consumer plus focused OFXP runtime/process tests. Do not broaden into unrelated capability implementation.
- **Objective:** an `authority-changed` event from a sibling process must invalidate resources admitted under the prior generation: authenticated connection pools/pairing state at runtime boundary and owned process handles at augmentation boundary. Retirement must be idempotent and fail closed.

## 2026-09-20 22:33 CT — ChatGPT authority-generation consumer retirement DONE

- **Status:** DONE; releasing runtime/process consumer claims.
- **Runtime:** generic `authority-changed` now closes pooled authenticated transport state for the changed peer. Pairing remains identity-only: generic grant/root changes do not cancel pairing, while a durable re-read that shows revoked/re-key-required trust does cancel pairing. Existing direct `revoked` / `rekey-required` behavior is preserved.
- **Process owner:** no production change was required; its existing generic subscriber semantics already retire all owned handles for an unscoped peer change. Added a real shared-WAL regression proving a process admitted by service B is retired after independent service A removes `process` authority.
- **Verification:** Core peer suite 17/17, 91 assertions; process suite 6/6, 27 assertions; runtime suite 11/11, 83 assertions. Runtime regression uses a captured peer-change boundary plus real runtime/connection-manager object and proves stable authority change closes transport without cancelling pairing, while revoked durable trust also cancels pairing.
- **Migration consistency:** `bun run migration --check` reports no pending schema changes and regenerated full schema matches. Target-local scoped type diagnostics are clean; remaining diagnostics are pre-existing `legacyVersionFile`, WASM, `seek-bzip`, Bun ambient, and unrelated `TextDecoder` issues.

## 2026-09-20 22:36 CT — ChatGPT ServerConnection discovery-seed bridge lane

- **Status:** CLAIMED / WORKING.
- **Initial files claimed:** `/instance/identity` OFXP projection hunk and focused identity tests; `OfxpRuntime` seed API hunk; OFXP Tier-0 route/schema/handler hunk + SDK contract; app-side server-seed coordinator only after backend contracts are green. Existing unrelated server/global edits remain concurrent-owned and must be preserved.
- **Objective:** make an already configured OpenFork `ServerConnection` a passive OFXP discovery seed without merging ServerConnection with OfxpPeer authority or leaking Basic/device credentials into discovery.
- **Security invariant:** the remote bootstrap projection is secret-free and grants zero trust. The app may use credentials only against the already configured server URL; the selected backend receives only a validated `CandidateSeed` projection (peer/realm/version/protocol/pairing/host+port), never username/password/token/canonical paths.
- **Performance invariant:** reuse existing configured-server lifecycle/health cadence; no per-peer reconnect/health loops and no workspace Instance bootstrap. Destination runtime owns one bounded discovery directory.

## 2026-09-20 23:14 CT — ChatGPT ServerConnection discovery-seed bridge DONE

- **Status:** DONE; releasing ServerConnection bootstrap/seed bridge, SDK contract, app seed coordinator, and focused OFXP Settings mutation-call claims.
- **Source bootstrap:** public `/instance/identity` now carries a secret-free `ofxp` projection from the process-global runtime. Disabled state reveals only `enabled:false`; active state exposes peer id, public fingerprint, protocol range, pairing support, and bounded listener-port hints. The underlying `instanceIdentity()` object remains unchanged for process pinning/service descriptors. No private key, grant, peer list, filesystem path, credential, or discovered endpoint is exposed.
- **Destination runtime:** OFXP now owns one provider-neutral bounded discovery `Directory`. mDNS is an optional provider writing only its own rows; stopping mDNS clears only `mdns` observations. Sanitized ServerConnection seeds are retained in process memory while OFXP is disabled and materialize when it starts, so configured-server fallback works even with mDNS disabled/degraded. Provider replacement cannot erase another provider's observations.
- **Tier-0 API:** authenticated `PUT /ofxp/discovery/server-seeds` replaces the bounded configured-server snapshot and forcibly assigns `source:"server"` in the handler. The route returns only `{accepted}` and is proven in the negative ownership graph with no `InstanceStore` or workspace runtime.
- **Generated SDK:** canonical `packages/sdk/js/script/build.ts` regeneration produced `client.ofxp.discovery.serverSeeds(...)` plus `OfxpSettingsServerSeed(s)Payload/Result`; SDK contract locks PUT path/body. Full SDK typecheck passes.
- **Renderer source projection:** `ofxp-server-seeds.ts` strictly parses the public bootstrap projection, never uses the authenticated SDK for `/instance/identity`, sends no Authorization header, and produces a credential-free seed object. Remote HTTP uses the configured hostname; SSH uses the actual remote SSH host rather than its renderer-local proxy; sidecars and loopback HTTP sources are excluded because forwarding renderer-relative localhost to another backend would route incorrectly.
- **Cadence/performance:** seed probing piggybacks on the existing server-health owner (20s seed refresh inside the existing 10s/SSE-aware health cadence). No second polling interval, per-peer timer, permanent reconnect loop, workspace Instance, provider catalog, or capability hydration was added.
- **Scoped backend targeting:** reconciliation is implemented by `OfxpServerSeedBridge` against `useServerSDK().server`, never `global.settings.server.selected`. It mounts under the normal active `ServerSDKProvider` and the explicit V2 Settings `?server=` provider. A module-level per-destination latest-wins queue deduplicates overlapping mounts and serializes writes so stale queued snapshots cannot overwrite newer snapshots.
- **Restart convergence:** the same public probe carries the server process `instanceID` into health state; destination signatures include `(instanceID + sanitized seed snapshot)`. A backend process restart therefore forces exactly one re-reconciliation even if configured source seeds are unchanged. OFXP disable/enable within one process remains safe because sanitized seeds are retained by the inactive runtime owner.
- **Removal/disable semantics:** deleted, unhealthy, destination-self, local/sidecar, incompatible-protocol, malformed, and source-OFXP-disabled entries do not appear in the reconciled snapshot. Source OFXP disable is observed on the bounded health probe cadence and removes the seed.
- **Concurrent contract repair:** canonical SDK regeneration exposed stale V2 OFXP mutation calls. Settings now sends `expectedPeerID` for rotate/finalize and the operator-viewed `grantRevision` for root approval and peer revoke. The scoped-backend architecture test now locks those fences.
- **Verification:** discovery 11/11 (49 assertions); runtime 12/12 (100); instance identity isolated 10/10 (27); Tier-0 ownership 17/17 (51); SDK OFXP contract 1/1 (6) + SDK typecheck green; app seed projection/synchronizer 7/7 (25); server health 9/9 (15); seed-bridge architecture 4/4 (19); V2 OFXP architecture 3/3 (27). Target-local app typechecks for seed utility, health owner, scoped bridge, and OFXP Settings pass; only the pre-existing package TS5069 `emitDeclarationOnly` configuration warning remains. One earlier batched identity run had all 10 named tests/27 assertions pass before an unnamed `afterEach` timeout; immediate isolated rerun was fully green.

## 2026-09-20 23:19 CT — ChatGPT ServerConnection bridge post-close hardening

- **Bounded coordinator:** per-destination reconciliation/dedupe state is capped at 64 LRU-like entries. Eviction advances the old generation fence before dropping state so queued stale work cannot survive historical server churn. Revisit after eviction intentionally performs a fresh authoritative snapshot.
- **Credential hardening:** the public `/instance/identity` probe now clears URL `username`/`password` in addition to bypassing the authenticated SDK and omitting Authorization headers. Even legacy/manual URLs containing `user:pass@host` cannot forward those credentials to the public bootstrap route or seed payload.
- **Restart fence:** destination process `instanceID` from the same secret-free bootstrap probe is retained in health state and incorporated into the destination reconciliation signature. Same-key backend restarts therefore force a fresh seed snapshot even when every source seed is unchanged.
- **Verification amendment:** app seed projection/synchronizer suite is now 8/8 with 27 assertions; bridge architecture remains 4/4 with 19 assertions; no additional polling owner was introduced. Source search confirms `useServerHealth` has exactly one app owner.


## 2026-09-20 23:30 CT — ChatGPT App Server Connections × OFXP overhaul lane

- **Status:** CLAIMED / WORKING.
- **Files claimed:** `packages/app/src/components/settings-v2/servers.tsx`, narrow UI-context/action exposure in `ofxp-network.tsx`, `packages/app/src/utils/server-health.ts` / `ofxp-server-seeds.ts` identity projection only as needed for renderer-visible verified identity state, focused V2 CSS/i18n/tests. Existing OFXP backend/runtime/trust semantics remain untouched unless a verified UI contract gap requires a narrow change.
- **Objective:** make App server connections a first-class consumer of OFXP discovery/identity/trust context while preserving the architectural distinction: ServerConnection chooses the app backend; OfxpPeer controls cryptographic peer trust and capability authority.
- **UX target:** premium New York-dense connection cards with backend health/type/default/scoped state, verified OFXP identity, candidate/pairing/trusted/re-key/authorized correlation, explicit identity-only Pair/Verify action, Manage-here scoped Settings retargeting, and clear states for OFXP-disabled/unsupported/unreachable servers.
- **Safety invariants:** never derive an app HTTP backend from the dedicated OFXP listener endpoint; never silently pair; never grant capability authority from a ServerConnection action; never duplicate `ofxp.state` polling; never send stored server credentials to discovery endpoints; preserve explicit revision fences for all authority mutations.
- **Performance invariant:** reuse the existing one server-health/bootstrap cadence and the already-loaded scoped OFXP Settings state. No per-server OFXP pollers, workspace Instance bootstrap, or N-peer liveness loops.
