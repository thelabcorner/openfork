# OXP parent tool epoch and durable continuation

## Purpose

OXP supports an already-running ChatGPT-side agent through OpenAI's MCP tool
surface. That external tool surface has a host-imposed liveness constraint that
OpenFork cannot remove:

> **A ChatGPT parent session receives a finite, non-renewing OXP tool window.**

For the current ChatGPT/OXP integration, the observed host window is **25
minutes**. OXP calls made inside that window do **not** extend its deadline.
Once the window closes, the ChatGPT parent can no longer call OXP until the user
sends another message to that parent session and ChatGPT exposes OXP again.

This is not a tunnel-health failure. The OpenAI tunnel, the OpenFork sidecar, the
OXP MCP endpoint, grants, workers, and local runtimes may all remain healthy while
the ChatGPT parent temporarily loses the ability to issue another OXP call.

The architectural response is therefore **durable continuation**, not tunnel
keepalive behavior.

## Core invariant

Long-running work must not require continued possession of the ChatGPT parent's
current OXP tool window for correctness or ordinary execution progress. Native
permission and question requests are deliberate external decision points: a worker
may pause there until an authorized supervisor responds, including after a later
parent-tool epoch reopens.

Direct augmentation and supervision calls remain appropriate for bounded work.
When meaningful work may outlive the current parent-tool window, the ChatGPT
parent should transfer the remaining execution into a durable native OpenFork
worker before the window expires.

`openfork_worker` is therefore both:

- the OXP delegation surface; and
- the OXP continuity/handoff primitive.

The worker is a real native OpenFork Session with durable execution ownership. It
does not depend on the MCP request or parent tool window that created it.

### Native request blocking

Delegated workers must distinguish **executing** from **waiting for external
input**. A native Permission or Question request is not a worker failure and must
not be hidden behind an indefinitely generic `running` state.

Supervisors must likewise never derive a stale-worker conclusion solely from a
quiet message tail, unchanged Session timestamp, or elapsed wall time. Those are
all expected while the native runner is suspended on the Permission/Question
Deferred. Before replacing, cancelling, or declaring a worker exhausted, the
supervisor must classify it through `openfork_worker wait/result`; a
`state="blocked"` result means the execution is healthy but externally gated.

The ownership split is:

- native Permission/Question services remain the authoritative owners of pending
  requests and their deferred execution;
- the delegated-worker owner projects a safe `blocked` execution state plus
  non-sensitive request references;
- OXP `openfork_worker wait/result` carries that projection to the external
  supervisor;
- OXP `openfork_request` remains the single mutation surface for listing and
  resolving those requests. Every projected blocker carries its owning
  `sessionID`: for a direct blocker this equals the worker ID, while a blocker in
  a nested delegated child carries that child Session ID.

The supervisor resolves the request and then waits on the **same worker** again.
It must not cancel/restart a healthy worker merely because it is blocked. OXP must
also never let a delegated worker approve its own permission request: request
supervision remains a separately authorized plane with commit-time authority
revalidation. An `external_directory` blocker is explicitly marked and remains
reject-only over OXP; its native path stays redacted.

If the process-local delegated BackgroundJob is absent, OXP must not treat a stale
durable execution-owner row as proof of active execution. The worker is projected
from durable message/request state as recoverable, blocked, terminal, or idle
instead of polling forever as generic `running`.

If the parent tool epoch expires while a worker is blocked, the worker remains
truthfully blocked rather than losing or fabricating the decision. A later epoch
can rediscover the worker, inspect the pending request, resolve it if authorized,
and allow the existing execution to continue.

## Parent-session scope

Tool epochs are tracked **per ChatGPT parent session**.

OpenAI now documents the canonical correlation primitive directly on tool calls:

```text
_meta["openai/session"]
  = anonymized conversation id
  = correlate tool calls within the same ChatGPT session
```

That field is the preferred epoch key and is modeled as
`scheme="openai/session", scope="conversation"`. The raw value exists only at
the OXP boundary and is pseudonymized before durable Core activity state sees it.

`_meta["openai/subject"]` is deliberately **not** a fallback. OpenAI documents
it as anonymized user identity for rate limiting/identification, so using it here
would merge distinct ChatGPT conversations owned by the same user.

`Mcp-Session-Id` is not ChatGPT conversation identity and is not accepted as
an OXP correlation fallback. OXP's canonical ingress contract is MCP
`2026-07-28`; the temporary stateless 2025 transport adapter exists only so
the currently deployed ChatGPT connector can reach that contract. It does not
turn the old transport session header into parent identity.

The epoch key must not be substituted with:

- TCP connection identity;
- tunnel process identity;
- MCP transport object identity;
- request ID;
- OXP connector ID;
- native OpenFork SessionID.

Those objects have different lifetimes or cardinalities and would merge or split
epochs incorrectly.

If documented `openai/session` metadata is absent, the call is unattributed.
Do not guess an identity from network/process state.

## Observed epoch state

The tracker is small, process-local transport state:

```ts
interface OxpParentToolEpoch {
  parentSessionRef: string
  epoch: number

  // First OXP call observed for this non-renewing epoch.
  epochObservedAt: number

  // Activity only; never used to renew the deadline.
  lastCallAt: number
  callCount: number

  // Prevent unbounded repeated prose.
  handoffReminderDelivered: boolean

  // Optional evidence that durable continuation already exists.
  workerIDs: Set<string>
}
```

This state is:

- **Tier 0 / process-local**;
- not a source of authorization;
- not durable correctness state;
- safe to lose on sidecar restart;
- evaluated on requests, not by a periodic polling timer.

A restart may make the next timing estimate conservative or incomplete, but must
never revoke authority, invent authority, stop a durable worker, or fabricate a
ChatGPT backing Session.

## Canonical state machine

The canonical v1 behavior is:

```text
first observed OXP call for parent session
        |
        v
epochObservedAt = now
epoch += 1
        |
        | calls may happen arbitrarily often
        | lastCallAt/callCount update
        | epochObservedAt DOES NOT MOVE
        |
        v
epochObservedAt + 20m
        |
        | next arbitrary OXP call occurs
        v
append continuity reminder to the normal call response:

  "This OXP tool window is nearing expiry.
   If substantial work remains, delegate it now to a
   durable OpenFork worker so execution can continue
   after the parent loses OXP access."

        |
        | calls still DO NOT renew the epoch
        v
epochObservedAt + 25m
        |
        v
old observed epoch is no longer usable

next successful OXP call for the same parent session
        |
        | a successful post-deadline call is evidence
        | that the user/host reopened OXP
        v
begin a new observed epoch
epochObservedAt = now
epoch += 1
handoffReminderDelivered = false
```

The implementation rule is correspondingly simple:

```ts
if (!epochFor(parentSessionRef)) {
  beginEpoch(parentSessionRef, now)
} else if (now >= epoch.epochObservedAt + 25 * MINUTE) {
  beginEpoch(parentSessionRef, now)
} else {
  epoch.lastCallAt = now
  epoch.callCount += 1
  // Never move epochObservedAt here.
}
```

## The 20-minute handoff reminder

The **first normal OXP response observed at or after 20 minutes** in an epoch must
carry a continuity advisory. The reminder may adapt its wording when durable
continuation is already established, but the threshold itself does not depend on
guessing whether the parent is "really" finished.

This is response decoration at the common OXP server boundary. Individual
filesystem, Git, process, Session, MCP, and worker owners must not learn about the
25-minute ChatGPT host constraint.

The preferred flow is:

```text
ChatGPT parent
    |
    v
OxpServer / parent-epoch tracker
    |
    v
normal dispatch to authoritative owner
    |
    v
OxpResult
    |
    v
epoch-aware response decoration
    |
    v
MCP response to ChatGPT
```

The advisory should be operational, not merely informational. It should tell the
parent to:

1. stop beginning long serial direct-operation loops;
2. call `openfork_worker start` if substantial work remains;
3. give that worker a self-contained handoff containing objective, current state,
   constraints, and remaining work;
4. preserve the returned durable worker handle;
5. **not** spend the remaining parent window repeatedly polling `wait`.

If durable continuation is already established, the reminder should say so and
prefer letting the worker continue instead of spawning redundant workers.

To avoid context spam, the full reminder is emitted once per observed epoch. A
later call may carry a short bounded reminder if necessary, but repeated calls
must never create unbounded reminder text.

Structured response metadata may additionally expose:

```json
{
  "oxp": {
    "continuity": {
      "epoch": 3,
      "observedAgeMs": 1234567,
      "state": "handoff-recommended",
      "deadlineModel": "non-renewing-25m-observed-epoch",
      "recommendedAction": "openfork_worker.start"
    }
  }
}
```

This metadata is advisory and must not be interpreted as authority.

## Why the timer is conservative

`epochObservedAt` means **first observed OXP call**, not necessarily the exact
moment ChatGPT opened the external tool window.

For example:

```text
user sends parent message      first OXP call
T+0 --------------------------- T+3m
```

The real host deadline could therefore occur before
`epochObservedAt + 25m`. The 20-minute handoff threshold intentionally leaves a
safety margin.

If future installed-runtime evidence proves that an earlier MCP event such as
`initialize` or `tools/list` is reliably emitted at window creation and can be
correlated to the same stable parent session, that earlier event may replace the
first tool call as the epoch anchor. Do not make that assumption without evidence.

## A successful post-25-minute call starts a new epoch

OXP does not need an explicit "new lease" message.

If the same parent session successfully calls OXP after the previous observed
epoch has reached its 25-minute maximum lifetime, that call cannot belong to the
old observed epoch under the current host behavior. The successful call itself is
the evidence that the user/host reopened OXP.

The tracker therefore resets the observed epoch on that call. It must not carry
the prior epoch's reminder flags or deadline forward.

## Delegation is the continuity boundary

The external ChatGPT principal itself does not become durable merely because OXP
needs continuity.

Instead:

```text
ephemeral external execution
ChatGPT -> OXP -> direct augmentation/supervision
        lifetime depends on current parent tool epoch

durable delegated execution
ChatGPT -> OXP -> native OpenFork worker Session
        lifetime depends on OpenFork durable execution ownership
```

This preserves the existing OXP identity rule:

- ChatGPT still has no fake backing OpenFork Session;
- the OXP principal remains external;
- delegated workers have truthful `oxp.delegation` / `workerDelegation`
  provenance;
- worker execution survives parent-tool expiry;
- the next reopened epoch can rediscover workers through
  `openfork_worker list/get/result/continue`.

The transport tracker may remember worker IDs as an optimization/advisory hint,
but durable worker discovery must continue to come from native Session metadata
and execution-owner state.

## Non-solutions

Do not attempt to "keep the window alive" with:

- MCP notifications;
- synthetic no-op calls;
- tunnel reconnects;
- progress events;
- schema refreshes;
- periodic pings;
- server-initiated pseudo-messages;
- fake ChatGPT Sessions;
- automatic worker creation merely because a clock threshold was reached.

Those mechanisms either cannot renew the ChatGPT parent tool window or would
silently widen execution authority.

The tracker observes liveness. The parent agent decides whether to delegate
through the currently authorized OXP delegation/root/nested-delegation boundary;
model and agent selection remain per-call runtime preferences rather than a
separate OXP authorization policy.

## Metrics and privacy

Useful per-epoch metrics are bounded and non-content-bearing:

- epoch count;
- `epochObservedAt`;
- `lastCallAt`;
- call count;
- reminder emitted/not emitted;
- number of durable continuation workers established;
- `conversationCorrelatedCalls`: calls attributed through documented
  `openai/session`;
- `unattributedParentCalls`: calls for which no admissible correlation exists.

Do not retain prompt text, tool arguments, file paths, credentials, or native
Session transcripts merely to implement epoch tracking. The correlation-source
counters contain **counts only**: they never include the raw correlation value,
its process-local hash, the durable HMAC digest, `openai/subject`, or any other
identifier. Installed-runtime certification can therefore prove which correlation
path is actually being exercised without weakening the privacy boundary.

## Required tests

Architecture and packaged-runtime certification must cover:

1. calls at 5/10/19 minutes do not move `epochObservedAt`;
2. the first call at or after 20 minutes gets the handoff reminder;
3. the reminder does not alter the underlying tool result or mutation truth;
4. worker start before expiry survives complete loss of parent OXP access;
5. absent an explicit native Permission/Question decision point, no parent call is
   required for the worker to finish;
6. a successful call after 25 minutes creates a new epoch and resets reminder
   state;
7. reopened parent can recover the worker by durable handle or list discovery;
8. multiple parent sessions maintain independent epochs;
9. tunnel reconnect or sidecar lifecycle events do not masquerade as parent epoch
   renewal;
10. tracker loss/restart does not affect authority or worker correctness;
11. disabled OXP still creates no periodic epoch timer;
12. no response advisory leaks paths, secrets, provider credentials, or internal
    native Session state;
13. identical `openai/session` values correlate across tool calls;
14. distinct `openai/session` values remain distinct;
15. `openai/subject` never becomes conversation identity;
16. 2025-era ingress is accepted only through the stateless transport adapter,
    while `Mcp-Session-Id` is never accepted or inferred as parent identity;
17. a delegated worker awaiting Permission/Question is surfaced as `blocked`
    rather than indefinitely `running`;
18. blocked worker output exposes only safe request references and directs
    resolution through `openfork_request`;
19. resolving a blocked request resumes the same worker execution instead of
    requiring cancellation/restart;
20. parent-epoch expiry while blocked does not discard, auto-approve, or fabricate
    the pending decision;
21. correlation-source counters distinguish canonical and unattributed calls
    without retaining any identifier value;
22. a blocker in a nested delegated child is projected on the parent worker with
    the child `sessionID`, and resolving that child request resumes the same
    parent worker;
23. a request resolved concurrently by another supervisor is reported as
    `OXP_NOT_FOUND`, never as a dependency/infrastructure failure;
24. a stale durable execution-owner row without a live delegated BackgroundJob
    projects `recoverable`/terminal state instead of polling forever as
    `running`;
25. an `external_directory` blocker exposes only a reject-only marker and safe
    request reference; its native path remains redacted.

This behavior is a Gate N replacement/soak requirement. OXP should not be called a
complete standalone LocalMCP replacement until long-running work survives the
ChatGPT parent-tool boundary through this durable handoff path.
