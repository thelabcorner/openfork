# Client control and activation implementation ledger

Date: October 1, 2026. Scope: renderer-side latest-state event interest, activation repair guard, and the hydration capability fallback. The app/server was not restarted or exercised. Production files outside the scoped app paths were not edited by this work; the shared checkout remains dirty.

## Changes

- Added `packages/app/src/context/latest-state-request.ts` as one owner for remote latest-state requests. A queued closure reads the newest desired value at admission and promotes its stable scheduler key. A different desired value aborts a started request before scheduling the replacement; context teardown and stream disconnect abort pending work. The helper serializes local requests, tracks which desired key was acknowledged, avoids retry spinning after errors or a registry-deferred response, rebases on a server supersession, and blocks safely if the generation space is exhausted.
- `packages/app/src/context/server-sdk.tsx` now assigns an increasing generation whenever effective visible stream interest changes. Both nonempty activation and empty/release interest use the `critical` client scheduler lane. POSTs include `{subscriber, generation, sessions}`; the `eventStreamFetch` request adds the same generation in `x-opencode-stream-generation` with the subscriber/session headers. A superseded or same-generation-conflicting response with a valid current generation rebases the current desired set to `max(local, server)+1` and retries; it is not acknowledged until that exact generation is accepted. Invalid server revisions and generation exhaustion fail closed rather than spin. A stale deferred response only suppresses retry if it still describes the newest desired key.
- Legacy `message.part.delta` coalescing in the renderer queue preserves the earliest `offset` and merges versioned fragments only when the next UTF-16 code-unit offset is contiguous. Gaps, overlaps, reordering, and mixed offset/unversioned pairs remain separate events; unversioned pairs retain old compatibility coalescing.
- `packages/app/src/utils/event-stream-auth.ts` accepts an optional generation accessor and only adds its header to event-stream paths. The existing auth tests assert that header and continue to assert ordinary API traffic receives no interest headers.
- `packages/app/src/context/server-sdk.test.ts` now asserts critical priority for both active and empty interest. Helper tests cover queued replacement/promotion, active request abort/replacement, supersession rebase (`request=1`, server revision `3`, retry `4` with current sessions), generation overflow blocking, stale-deferred replacement, and cancellation when the stream loses readiness.
- `packages/app/src/context/server-session.ts` guards `client.session?.message` before probing the optional keyed-message capability. This was the exact throw site in the three known hydration failures with an incomplete client object; split-turn, synthetic-root, and historical-state-root tests now pass.

## Ownership path

V1 session runtime produces durable message/event truth. The server global event route owns the interest registry and filters the shared SSE event feed. The app session store owns active session IDs, stale/suspended latches, and history reconciliation; its callback supplies the effective desired set to the server SDK. The SDK owns one subscriber's transport interest and coalesces its state. The event reader checks the store before queueing, then `ServerSession` reconciles dropped content from message pages for the mounted timeline.

The reverse demand path starts at timeline activation: `resume(sessionID)` changes the local set, the callback updates desired interest/generation, the SDK submits the latest set through critical admission, and `ServerSession` performs an authoritative repair when local content is stale. This implementation improves the client-to-registry path but does **not** turn registry acknowledgement into an SSE replay/cursor barrier. The parent is adding server generation-aware latest-wins semantics to the existing V1 endpoint. Readiness still must not be reported as cursor-reconciled until that boundary exists.

## Validation

From `packages/app`:

```text
bun test --conditions=solid --preload ./happydom.ts ./src/context/latest-state-request.test.ts ./src/context/server-sdk.test.ts ./src/context/server-session.test.ts ./src/utils/event-stream-auth.test.ts
150 passed, 0 failed

bun run typecheck
current tree is blocked by unrelated diagnostics in `test/fixture/markdown-httpapi-gate.ts` (wrong BackgroundJob import and multiple Effect/fixture type mismatches). No source diagnostic from the session-create route, Config projection, or Session.createForLocation remained after fixes; the new test's unsupported timeout argument was also removed.
```

The tests prove local coalescing, promotion/cancellation, serialization, supersession rebase, safe overflow blocking, stale-deferred replacement, offset-preserving legacy coalescing, priority classification, path scoping for generation headers, and repair hydration capability fallback. They do not test the parent's server generation implementation, HTTP connection-pool isolation, an SSE cursor barrier, or real Electron active-stream latency.

## Remaining risks and next work

- Generation-aware server compare-and-set must land with its route/registry tests before concurrent superseded network requests can be considered safe. The client keeps one logical request at a time but abort can race with a server that already received the body; generation enforcement is the stale-write fence. A stale deferred response will not park a newer desired set, and an exhausted generation blocks rather than retrying forever.
- Server `{updated, generation}` remains only a registry acknowledgement. Activation must stay locally stale/content-gated until a future cursor/replay/snapshot boundary proves the transition to live delivery. This implementation makes no such claim.
- The renderer's `critical` lane is a client-side admission reservation. A shared saturated HTTP connection, server event loop, synchronous SQLite operation, or database writer can still block it. Parent-owned server/transport/storage isolation remains necessary.
- Run the active 1/3/6+ Electron scenario after the cross-layer implementation lands. Correlate the local generation, initial header, POST, server applied generation, repair snapshot, first provider event, and first visible content; do not restart or prompt the user's current app during this investigation.

## Server V1 cancellation control path

The V1 `POST /session/:sessionID/abort` endpoint now has a dedicated API group outside `InstanceContextMiddleware`. It authenticates and uses workspace routing, then resolves the durable `Session.Info` location and checks producer ownership and caller location hints before requesting an interrupt. The response remains the existing V1 boolean acceptance shape. The route reads `SessionExecutionOwner` and signals the exact generation through `SessionRunState`'s process-level active-handle index; that index stores only a cancellation closure to the existing runner, not a second runner or execution owner. Exact-generation fencing prevents a delayed abort from canceling a later turn. The existing runner callback is responsible for canceling its instance-scoped background jobs, so the fast path does not create an `Instance`.

Ownership path: durable Session storage and `SessionExecutionOwner` remain authoritative for identity and generation; `SessionRunState` remains the owner of local Runner lifecycle; the control route is a narrow V1 adapter that authenticates, validates durable location/producer metadata, requests the durable interrupt, and signals only a matching local handle. No-handle/remote-owner requests preserve durable interrupt acceptance without claiming local cancellation. This avoids waiting on config/plugin/tool bootstrap for an already-running local execution while preserving V1 execution semantics.

Validation from `packages/opencode` and `packages/core`:

```text
bun test test/server/httpapi-session.test.ts -t "aborts an active V1 handle"
1 passed; spy verified InstanceStore.load() was never called

bun test test/session/run-state-abort.test.ts
12 passed, including exact-generation cancellation and 1/3/6 active handles

bun test test/session-execution-owner.test.ts
16 passed, including stale-generation interrupt fencing
```

The route-level test exercises one local handle and proves zero Instance loads; the RunState test exercises 1, 3, and 6 concurrently active handles. This does not yet prove desktop transport latency or cancellation of orphaned instance-scoped BackgroundJob work when no local Runner handle exists. Such work is not guessed at or canceled by bootstrapping an Instance on this control route; a separate authoritative process-level job owner would be needed if orphan-only jobs are a supported abort state. Cross-process owners receive the durable interrupt, while local cancellation is only claimed for a matching process handle.

## V1 session creation admission

`POST /session` now remains the same V1 path and schema, but is served from its own `SessionCreateApi` layer with authentication and explicit workspace routing, outside `InstanceContextMiddleware`. The handler resolves durable `Project.fromDirectory` metadata for the supplied directory, validates a requested agent against the location-aware AgentCatalog, strips public metadata ownership fields, and calls the new trusted `Session.Service.createForLocation` seam. `Session.create` delegates through the same seam from its existing Instance context, so there is one durable producer. The producer still allocates and reclaims projectless Chat scratch directories, publishes the created event with the resolved worktree, and starts group projection with an explicit `InstanceRef`; it no longer silently reads ambient Instance state.

The old `SessionShare.create` wrapper also decided auto-share by calling full `Config.get()`, which initializes workspace configuration and plugin/dependency state. The admission route now asks `Config.sharePolicyForLocation` for a narrow share projection across global and workspace JSON/JSONC files, custom config path/content, project config directories, locally materialized active-account configuration, and managed configuration. It does not invoke plugin resolution, package installation, or an Instance to decide whether auto-share applies. Only when `OPENCODE_AUTO_SHARE` is enabled or this projection returns `share: auto` does it submit the session ID to one route-scope auto-share worker. The owner has one consumer, a dropping backlog capped at 32 jobs, and a pending-session set that coalesces duplicate IDs; teardown interrupts the worker and discards queued work. With sharing disabled, a create no longer triggers background bootstrap just to discover that no share action is needed.

Validation from `packages/opencode`:

```text
bun run typecheck
passed

bun test test/server/httpapi-session.test.ts -t 'admits V1 sessions'
1 passed: concurrent groups of 1, 3, and 6 returned 10 unique sessions while InstanceStore.load() was mocked to never; zero calls observed

bun test test/server/httpapi-session.test.ts -t 'lifecycle mutation routes'
1 passed: V1 empty-body, whitespace-body, and JSON session creation; malformed JSON remains 400; existing lifecycle operations pass

bun test test/session/auto-share-queue.test.ts
2 passed: queue capacity/drop behavior, exact SessionID coalescing, and worker interruption on owner-scope teardown
```

This verifies the backend admission boundary under blocked Instance loading, not Electron end-to-end latency or the desktop admission-pool classifier. Active-account config is read from its local materialized store, and managed files/preferences are included. Well-known remote config remains unavailable to this projection because discovering it would require outbound network I/O during admission; that source cannot trigger implicit auto-share through this endpoint until a cached policy projection exists. Queue overflow drops only best-effort sharing and emits a warning; session creation still succeeds. `POST /session` should enter the desktop urgent lane only after the parent verifies SDK/OpenAPI regeneration.

## V1 active Permission and Question response control

`POST /permission/:requestID/reply`, the legacy `POST /session/:sessionID/permissions/:permissionID`, and `POST /question/:requestID/{reply,reject}` now run in separate authenticated control groups with explicit workspace routing and no `InstanceContextMiddleware`. A process-global `PendingResponseRegistry` indexes only active asks, keyed by kind and exact request ID, and binds each entry to its exact SessionID and normalized directory. Routes settle only a matching active handle; the legacy session route additionally requires exact session ID. When the handle is gone, the existing domain-specific 404 response is returned. The registry is registered in the served application graph explicitly.

The V1 Permission and Question services remain the sole owners of request semantics, permission rules, normalization, and their Deferreds. Their ask lifetime registers/unregisters the route handle in the same cleanup scope as the InstanceState pending entry. Reply/reject first update the owner state and complete/fail the exact ask Deferred, then enqueue the V1 `permission.replied` / `question.replied` / `question.rejected` event. Inspection confirmed these V1 events are non-durable (`define` has no `durable` metadata), so notification is transient. A single process-scoped worker handles a queue capped at 128; routes never await event listeners. On overflow, it coalesces affected directories (at most 32) and falls back to one process-wide invalidation marker. Once the worker can make progress, it publishes `server.pending-response-state-invalidated`; failed non-interrupt publication retries with capped exponential backoff without discarding the marker or killing the worker. A client refreshes the registry-backed active snapshot for loaded locations and replaces its pending projection. Overflow logging is once per episode rather than once per dropped event.

Validation from `packages/opencode`:

```text
bun test test/server/httpapi-session.test.ts -t 'answers active pending-response handles'
1 passed: concurrent groups of 1, 3, and 6 active handles returned success; InstanceStore.load() mocked to never and had zero calls

bun test test/question/question.test.ts -t 'blocked transient event listener'
1 passed: Question ask resolves while its Replied event listener remains blocked

bun test test/permission/next.test.ts -t 'reply - publishes replied event'
1 passed: asynchronously queued Permission Replied notification remains observable

bun test test/permission/next.test.ts -t 'blocked transient event listener'
1 passed: Permission ask resolves while its Replied event listener remains blocked

bun test test/server/httpapi-session.test.ts -t 'overflowed transient notifications'
1 passed: a blocked notification consumer and 129 queued notifications trigger invalidation; the exact active snapshot is returned with zero InstanceStore.load() calls

bun test src/context/global-sync/pending-response-snapshot.test.ts
1 passed: authoritative active snapshot clears stale rows and groups current requests by session

bun test src/context/global-sync/pending-response-repair.test.ts
6 passed: the actual ServerSync repair owner autonomously repairs 1/3/6 loaded directories, clears stale permission/question rows without tab pins, retries a temporary list failure without new input while other directories progress, supports multiple idle waiters, and cancels retry timers on teardown
```

The HTTP regression uses registered active handles to isolate the real served route/middleware path and its zero-Instance invariant; it does not yet exercise a full provider-originated Permission/Question ask over the HTTP route. The Question and Permission service tests cover the blocked-listener interleaving. The overflow regression verifies server-side invalidation and the exact active snapshot route. The app test drives the same bounded repair owner instantiated by `ServerSync`, using fake V1 list clients and real snapshot replacement semantics; it verifies 1/3/6 loaded directories without relying on session/tab pins. It also verifies autonomous retry after a failed snapshot and retry-timer teardown. It does not establish desktop end-to-end recovery latency. Cold locations recover from the next normal bootstrap; the repair worker refreshes only currently loaded locations. No application or server was restarted.

## October 2 cancellation fence correction

A final stale-generation audit found two semantic gaps after the original fast abort path landed. First, a delayed V1 abort whose generation compare-and-set returned `stale` still returned the public boolean `true`, falsely describing the request as accepted even though no interrupt intent was recorded. The route now returns `false` for that case and skips automation cancellation. The V1 compatibility adapter treats a non-true abort result as a superseded execution and rejects the interrupt call, so callers cannot silently proceed as if the newer run had stopped.

Second, the in-process `SessionRunState.stopCurrent` path requested a durable interrupt without passing its locally registered generation. It now calls `requestInterrupt(..., existing?.token.generation)`, matching the control route's generation fence. A regression releases the old durable owner, acquires a newer generation while the old local entry still exists, invokes local cancel, and proves the newer owner/generation survives.

The page-level rollback/revert helper no longer catches and discards interrupt errors before staging/clearing revert state. Focused results after the correction: RunState abort suite 13 passed; delayed stale HTTP abort test passed and returns false; app server-compat suite 21 passed including the superseded-abort case. The current Core/V2 `/api/session/:sessionID/interrupt` route was independently rechecked and already calls `SessionV2.interrupt`; no duplicate V2 cancellation path was added.
