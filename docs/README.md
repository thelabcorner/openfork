# OpenFork documentation

This directory is organized by **document authority and lifecycle**, not by whichever
campaign happened to create a file.

The repository-wide architecture contract is still [`../AGENTS.md`](../AGENTS.md),
and fork/upstream ownership is still canonical in [`../FORK.md`](../FORK.md).
The docs tree explains and records those contracts; it does not replace them.

## Directory map

| Directory | Purpose | Expected lifetime |
| --- | --- | --- |
| [`map/`](./map/README.md) | Canonical orientation map of the repository, runtimes, packages, V1/V2 boundaries, and fork/upstream split. Start here. | Long-lived; update with architecture changes. |
| [`architecture/`](./architecture/) | Durable design truths and cross-cutting architecture decisions. | Long-lived. |
| [`specs/`](./specs/) | Normative subsystem/API/package specifications. A spec should state whether it describes current behavior or a migration target. | Long-lived while the contract exists. |
| [`plans/`](./plans/) | Active implementation plans, research ledgers, migration plans, and design campaigns. | Active until closed or superseded. |
| [`handoff/`](./handoff/) | Campaign handoffs, audits, closeouts, incident notes, and worktree/state transfer documents. | Historical/operational evidence. |
| [`perf/`](./perf/) | Performance methodology and reusable benchmark guidance. | Long-lived evidence/methodology. |
| [`checkpoint/`](./checkpoint/) | Existing checkpoint-specific design documents retained as a domain collection. New cross-cutting work should use the lifecycle folders above. | Domain-specific. |
| [`drafts/`](./drafts/) | Deliberately non-authoritative drafts. | Temporary. |
| [`assets/`](./assets/) | Documentation assets. | As needed. |

## Placement rules

Keep the root of `docs/` empty except for this index. New material should answer
one question before it is created:

1. **Is this a map/orientation document?** Put it in `map/`.
2. **Is this describing an architectural truth that code should continue to obey?**
   Put it in `architecture/`.
3. **Is this a normative contract for one subsystem?** Put it in `specs/`.
4. **Is this proposing or researching a change?** Put it in `plans/`.
5. **Is this recording a campaign, audit, incident, or closeout?** Put it in
   `handoff/`.

Do not promote an implementation plan or handoff into architectural authority merely
because it is newer. Conversely, once a plan converges into a durable rule, extract
that rule into `architecture/`, `specs/`, `AGENTS.md`, or `FORK.md` as
appropriate.

## Reading order for architecture work

1. [Repository agent contract](../AGENTS.md)
2. [Codebase map](./map/README.md)
3. [Fork ownership and sync policy](../FORK.md)
4. The relevant package `AGENTS.md`
5. The relevant durable architecture/spec document
6. Any active plan or handoff for the campaign being continued

The codebase is intentionally hybrid during the V1-to-current/V2 migration. Do not
infer ownership from a directory named `v2`, an SDK suffix, or a UI component name.
The dedicated [V1/V2 map](./map/v1-v2.md) defines those axes.
