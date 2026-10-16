# Swarm dispatch runtime ownership

## Incident: HTTP-owned Swarms with no worker runtime (2026-10-09)

The `silica-coverage-max` Swarm was durably active with managed worker
profiles and ready tasks, but initially had zero worker Session bindings:
`bindingGeneration=0`, `workingTaskCount=0`, no task runs and
`recover.members.requested=false`. Trying two model providers did not
change this. A later snapshot showed 30/30 active managed workers bound
(`bindingGeneration=1`) and 27 working tasks. **Do not mistake that eventual
recovery for proof that the initial host was correctly configured.**

### Authoritative causal chain

1. The HTTP sidecar route host constructed its own Effect graph in
   `src/server/routes/instance/httpapi/server.ts`.
2. That graph included `SwarmV2`, `SwarmMemberSessionWake`, and
   `SwarmProfilePreflight` but **not** the runner, dispatcher or deadline owner.
3. Thus API and native tools could create durable members/tasks without any
   `SwarmMemberSessionRunner` installing a wake handler. The
   `SwarmMemberSessionWake.request()` service correctly returned `false`.
4. With no runner, no member Sessions materialized. With no bound members,
   `SwarmDispatcher` could not admit tasks, leaving the DAG inert.
5. A separate execution entry point could later instantiate `AppRuntime`,
   which *did* own the runtime services, and reconcile the existing durable
   Swarm. Runtime startup from an auxiliary path is not an acceptable contract.

`SwarmV2` owns authoritative durable state, the member/session fence owns
binding generation, and the Session admission executor owns task dispatch.
Neither the UI nor a model/provider setting should be responsible for
reconstructing or enabling worker execution.

### Repair and invariants

`src/swarm/runtime-graph.ts` is the **single shared process-global service
inventory**, composed by both `src/effect/app-runtime.ts` and the served
`src/server/routes/instance/httpapi/server.ts`.

The graph includes member Session materialization, the wake service,
profile preflight, member reconciliation, session admission, runtime
retention, task and mail dispatch, retirement and closure, containment,
recovery, and the one deadline owner.

- A running host that accepts Swarm creation must install the matching
  worker execution graph **at host startup**, not only after an unrelated
  OXP/CLI call.
- Service nodes use process-global memoized Effect ownership, so serving
  both direct and HTTP graphs must not install duplicate listener sets
  or unbounded per-member polling timers.
- No implicit cwd/project fallback, cross-project Session binding, or
  relaxation of permission boundaries may be added to make a worker run.
- Ready tasks still require an active Swarm and active bound worker.
  Missing model/account, unprovable legacy requirements, ownership
  races, stopped members, stale generations and external-effect ambiguity
  must fail closed with explicit evidence.
- `recover.members` returning `requested=false` means the owner is
  missing, **not** that no recovery is needed. Repeated member.resume
  calls and new delegate Swarms must never be the production workaround.
- Active work must not be aborted or replayed merely to deploy a service
  graph fix. The change takes effect when the owning sidecar runtime loads
  the new code. Restart should be coordinated with safe Session/lease
  lifecycle; a source edit does not hot-replace an existing running process.

### Verification

`test/swarm/runtime-graph.test.ts` asserts the shared graph owns every
execution service exactly once and that both host construction sites
include the same graph. The existing `member-session-runner.test.ts` and
`dispatcher.test.ts` exercise actual event-driven reconciliation,
startup drain, scoped wake, and coalescing. Typecheck and broader
Swarm/sidecar tests must be reviewed independently before release.

A full deployment verification additionally requires a **fresh HTTP-only
host**, an isolated test database/project, a managed worker with a valid
profile, one ready task and observations of (a) binding generation
advancing from zero, (b) one admitted run, (c) correct Session/lease
fences and (d) no duplicate runtime owners. Never reuse or mutate
an active user's 30-worker Swarm as a destructive smoke test.
