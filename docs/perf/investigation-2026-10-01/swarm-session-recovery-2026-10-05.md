# Swarm execution-fence recovery, October 5

Affected swarm: `swr_ef73fcc92ffemcVFvY8cdoURBu`,
`standalone-vectorizer-cleanroom-2026-10-04`, with 50 bound managed workers.
Reported member: `ses_swarm_swm_ef73fac3cffePZAV0i3XkNPDsC_1`.

## Authoritative path

Durable runtime-owner liveness plus Session execution generations and tool rows
produce recovery truth. SessionExecutionOwner grants an exact recovery claim
only after positive local death proof. SessionRecovery reads unresolved tools;
SessionContainment records interrupted outcomes as unknown and releases only
the claimed generation. SwarmContainment owns task/run outcome settlement and
member-binding validation. Native swarm tools, OXP, and the shell recovery script
call those owners; they do not overwrite database rows or replay failed tools.

Reverse demand is an operator requesting recovery of an existing bound member.
The domain resolves its Session and any task lease first. A task-owned Session
must retire through that task's exact lease generation. An orphan without a
lease previously had no corresponding swarm recovery action; `recover.session`
now provides it without recreating the worker or advancing its binding.

## Findings and changes

- The photographed edit schema failures were recoverable. The reported member
  subsequently reread and edited successfully. Its later stuck shell belonged
  to a dead process generation, rather than being caused by that schema error.
- Dead owners retained unresolved tool fences across app restarts. Automatic
  recovery correctly refused to assert that external mutations had stopped,
  but the operator recovery surface did not cover bound Sessions without leases.
- Live recovery exposed another race: sealing tools/releasing the Session before
  recording `contained_unknown` let unattended retirement supersede the run and
  return its task to ready. Recovery now persists an unsettled run and a
  review-pending task **before** removing hazards or releasing the Session.
  A crash between those operations retains recoverable Session state and does
  not authorize an unknown mutation to run again.
- HTTP and OXP Resume share `requireResumeReady`. Proven-dead unresolved effects
  cause an explicit refusal before clearing pause or advertising a wake. Healthy
  live-owner contention remains coalescible. OXP revalidates authority before
  recovery can mutate the claim.
- Renewal target discovery and deadline calculation exclude active leases whose
  member binding cannot satisfy renewal. Retiring leases remain renewable safety
  fences. The negative regression covers 1/3/6 invalid bindings and proves no
  impossible renewal can repeatedly schedule an immediate deadline.
- Aggregate age scans are coalesced for 60 seconds across existing operational
  wakes. No idle/per-member timer was introduced. Warning signatures omit growing
  idle age and emit only for newly observed or changed aggregate state; their
  maps are replaced with the bounded current scan window.

## Live evidence and limits

Initial task recovery contained 17 dead-generation task fences. Subsequent
Session recovery reached orphaned members too. One shell pass returned seven
stale task settlements, exposing the ordering race above; those results were
not counted as successful containment. Application restarts and concurrent
work occurred during the campaign, so counts from separate snapshots must not
be summed into a claim of 50 successful mutations.

At 21:19:53 UTC, all 44 owned members belonged to live sidecar PID 189548; there
were zero pending/running legacy tool rows predating its latest startup.
The named member completed a new assistant turn without an error. OXP
`recover.effects` returned an empty array. All 12 then-unowned members accepted
explicit OXP Resume calls; subsequent execution ownership converged to 44.
Provider errors, completed work, and ordinary contention remain distinct from
orphaned execution fences. This is not a claim that all tasks completed: the
snapshot still had blocked, failed, ready, and working tasks.

The accepted OXP runtime is
`sha256:a593d8e9a665ea983d0d0521da77ad9723d792cf3a6ed25958cfc048792aaed5`,
activation generation 3. The desktop log records trial acceptance at 21:16:06
UTC, and a fresh connector status call succeeded afterward. An in-flight status
call spanning the tunnel transition did hang; this remains contradictory
transport evidence for the broader OXP investigation, not a fully closed
control-plane reliability claim. Backend refresh also does not prove that every
pre-existing HTTP runtime graph has consumed new source.

The current desktop log reports the seven historical idle aggregates and two
historical partial-creation aggregates once, with a later warning only for a
changed aggregate. It no longer shows the reported millisecond repetition in
that observation window. Inert partial aggregates with durable work remain
preserved for operator decisions.

## Verification

Evidence is in `swarm-recovery-focused-tests-2026-10-05.log`,
`swarm-retirement-timer-tests-2026-10-05.log`, and
`swarm-aggregate-wake-tests-2026-10-05.log`. Tests assert positive death proof,
live-owner refusal, exact generations, binding preservation, no fabricated tool
success, unknown outcome before hazard removal, no automatic redispatch,
explicit reviewer retry, Resume refusal/recovery, and bounded aggregate scans
under 1/3/6 sessions' repeated wakes.

Whole-package typecheck still reports unrelated errors; no diagnostic was
reported in the changed recovery/containment/Resume source paths at this check.
The broader HTTP session-actions suite timed out during metadata/abort fixture
startup and was stopped; it is not a passing HTTP integration gate. These
limitations remain open alongside the wider timeline, prompt admission, and
OXP lifecycle campaign.
