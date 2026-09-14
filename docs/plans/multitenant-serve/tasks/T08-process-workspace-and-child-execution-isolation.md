# T08 - Process, workspace and child-execution isolation

**Lane:** OS/data-plane isolation  
**After:** T02  
**Unlocks:** T10, T13  
**Primary repos:** PresGen + OpenFork spawn seams  
**Architecture refs:** sections 0.1, 16, 28.3, phase 3, D13

**Coordination note:** implementation may begin after T02 in parallel with the
tenant-runtime work, but T08 must not close PASS until T05's canonical
TenantPaths/root layout has been consumed or proven equivalent by integration
tests. If T05 is not yet available, leave T08 PARTIAL after completing the
kernel/process primitives.

## Objective

Make hostile tenant tool execution unable to read or mutate sibling tenant
workspaces, secrets, `/proc` environment, or inherited handles merely because
many tenants share one OpenFork server process/cell.

This is an independent security boundary from T04-T07. Application tenant
checks do not protect against `bash`, LSP, MCP, compiler, or other child
processes that can use normal OS syscalls.

## Current-state finding that must be fixed

PresGen's live supervisor currently calls the existing process isolation helper
with `demote_uid_gid=false` and UID/GID `0`, so the current agent processes are
still root inside the shared sandbox container.

The repo already contains `proc_isolation.py`, including support for:

- UID/GID demotion;
- `umask=077`;
- `PR_SET_DUMPABLE(0)`;
- `PR_SET_NO_NEW_PRIVS(1)`;
- `close_fds=True`;
- a distinct process session.

Hosted mode must actually wire and prove these protections.

## Threat model

Assume tenant-controlled or model-generated commands try to:

- `cat` another tenant's workspace or config;
- enumerate `/sandbox`;
- read `/proc/<pid>/environ`;
- read another child's cwd/fds/cmdline where kernel permits;
- follow symlinks out of workspace;
- create hard links to sensitive files;
- exploit shared `/tmp` names;
- inherit privileged FDs/sockets;
- spawn large process trees;
- keep descendants alive after cancellation;
- use LSP/MCP subprocesses as a bypass around shell policy.

## Owned surfaces

### PresGen

Primary:

- `backend/src/presgen_backend/opencode/proc_isolation.py`
- `backend/src/presgen_backend/opencode/sandbox_supervisor.py`
- `backend/src/presgen_backend/opencode/workspace.py`
- `backend/src/presgen_backend/opencode/supervisor_contract.py`
- sandbox Dockerfile/entrypoint/user/group setup
- focused security/integration tests

### OpenFork

Audit/patch child-spawn entry points as required:

- shell/bash/PTTY tools;
- LSP process spawn;
- MCP process spawn;
- `ChildProcessSpawner`;
- browser/helper subprocesses if enabled in hosted mode;
- any child environment construction.

Prefer one brokered spawn abstraction over duplicating UID/cgroup policy across
every tool.

## Required design

### 1. Stable tenant OS identity

Derive or allocate an unprivileged UID/GID from opaque TenantRef via an
operator-owned mapping.

Requirements:

- deterministic within a cell or durable mapping;
- collision detection, not modulo-and-pray;
- not UID 0;
- no tenant-controlled UID/GID;
- ownership recreated correctly after restart;
- same tenant may share one UID across sessions initially;
- different tenants must not share a UID in production shared mode.

If finite UID range becomes a capacity concern, surface it as a cell admission
limit rather than silently reusing identities.

### 2. Tenant root permissions

Target layout follows T05, conceptually:

```text
/sandbox/<tenantRef>/
  home/
  data/
  config/
  workspace/<sessionRef>/...
```

Owner/mode policy must prevent another tenant UID from traversing or reading
sibling roots.

Use restrictive directory modes and `umask=077`. Verify actual kernel access,
not only Python path checks.

### 3. Privileged spawn broker decision

Preferred production design:

```text
OpenFork server = trusted service identity, not root
        ↓ narrow authenticated spawn request
supervisor/spawn broker = privileged only enough to set UID/GID/cgroup/ns
        ↓
tenant child = unprivileged tenant UID/GID + no_new_privs
```

Do not keep the entire OpenFork server root solely so it can `setuid` children
unless the spike proves a broker is substantially worse and a security review
accepts the tradeoff.

The task must make and document this decision with evidence.

### 4. Child environment reconstruction

Build child env from an allowlisted base plus explicit tenant/session values.

Do not inherit the OpenFork server's full environment.

Provider secrets should be passed only to the exact child that genuinely needs
them. Most shell/LSP children should not receive model-provider secrets at all.

### 5. `/proc` shielding

At minimum use:

- distinct UID across tenants;
- `PR_SET_DUMPABLE(0)` for same-tenant sibling environ protection;
- `PR_SET_NO_NEW_PRIVS(1)`;
- argv secret hygiene.

Probe/record stronger options:

- per-session PID namespace;
- user namespace;
- mount namespace;
- hidepid;
- seccomp/AppArmor.

Do not claim these stronger tiers unless live-tested in the actual Docker
runtime.

### 6. Process groups and cancellation

Every child tree must be associated with a cancellable process group/session.

Cancellation/tenant drain must terminate descendants and release scheduler
capacity. Add kill escalation with bounded grace period.

### 7. Resource limits

Spike and, where feasible, wire:

- cgroup v2 memory/CPU/PID limits per tenant/session;
- process count limits;
- stdout/stderr byte caps;
- timeout limits.

T12 owns higher-level admission/fairness; T08 establishes the OS enforcement
hooks/counters.

## Required adversarial tests

Run from an actual tenant child identity, not only unit-level path helpers.

### Filesystem

- read own workspace -> allowed;
- read sibling tenant workspace -> EACCES/denied;
- absolute sibling path -> denied;
- `../` traversal -> denied;
- symlink to sibling -> denied at operation or kernel ownership layer;
- hard-link attempt across tenant roots -> denied/contained;
- write sibling -> denied;
- enumerate sibling sensitive files -> denied as far as policy requires.

### `/proc`

- cross-tenant `/proc/<pid>/environ` -> denied;
- same-tenant sibling environ -> denied by dumpable policy where expected;
- no provider secrets in child argv;
- inherited FD list contains no OpenFork listening sockets, DB handles, secret
  pipes, or control sockets not explicitly delegated.

### Process lifecycle

- fork/child/grandchild all die on cancellation/drain;
- fork bomb/process storm meets PID/resource cap;
- tenant A process storm does not prevent B control cancellation.

### LSP/MCP

At least one representative LSP and one allowed MCP process run under tenant
identity and cannot read sibling root.

## Performance guard

Measure:

- child spawn latency before/after broker/demotion;
- shell tool startup p50/p95;
- broker RPC overhead if used;
- cgroup placement overhead;
- cancellation latency.

Security wins are mandatory, but avoid hundreds of milliseconds of avoidable
per-command broker setup if reusable safe primitives exist.

## Exit criteria

PASS only when:

- production hosted child processes are never UID 0;
- different tenants execute under distinct kernel identities or an approved
  stronger equivalent;
- sibling workspace reads/writes fail from hostile commands;
- `/proc` credential canaries pass;
- env/FD inheritance is allowlisted;
- cancellation kills process trees;
- spawn architecture decision is documented;
- per-session legacy mode still works.

## Handoff

`../results/T08.md` must include:

- UID/GID allocation scheme;
- filesystem ownership/mode policy;
- spawn broker decision/diagram;
- child env allowlist;
- actual Docker/kernel isolation probes;
- hostile command transcripts/results;
- spawn/cancel latency;
- T10/T13 API needed to request tenant-scoped child execution.
