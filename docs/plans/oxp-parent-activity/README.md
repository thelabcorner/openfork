# Gate P — OXP Parent Activity & Invocation Timeline

## Goal

Give OpenFork a first-class, durable, session-like observability surface for an
upstream ChatGPT parent using OXP without pretending that parent is an OpenFork
Session.

## Current status — 2026-09-19

The **local Gate P implementation is complete and focused verification is
green**. Durable ownership, privacy-preserving correlation, invocation spans,
restart settlement, typed resource lineage, reverse provenance, bootstrap-free
global inspection, shared live events, bounded client state, and the no-composer
timeline UI are implemented.

The correlation semantics are no longer an open inference problem. OpenAI
documents tool-call `_meta["openai/session"]` as an anonymized conversation ID
for correlating calls within the same ChatGPT session, so Gate P records that
mechanism as `scheme="openai/session", scope="conversation"`. The separate
`openai/subject` user identifier is never used as conversation identity.

Gate P is **not declared finally installed-closed yet** because item 11 below is
still an external runtime-conformance requirement: the packaged ChatGPT/Secure
MCP Tunnel path must prove that the documented metadata actually arrives on the
relevant installed calls and that the 20/25-minute host behavior holds. A legacy
`Mcp-Session-Id` may be retained only as handshake-era compatibility evidence
with `scope="unknown"`; it is not promoted into ChatGPT conversation identity.

The feature answers:

- Which upstream ChatGPT parent correlation produced these OXP calls?
- What did OXP do, when, and for how long?
- Which calls overlapped?
- Which calls mutated durable state?
- Which native Sessions/workers/tasks/processes/files were touched or created?
- Which observed 25-minute parent-tool epoch did a call belong to?
- Did an operation fail before commit, commit before cancellation, or remain
  externally ambiguous?
- Can a user jump bidirectionally between an OXP invocation and the native
  OpenFork resource it created or supervised?

The canonical object is an **OXP Parent Activity**. It is not a message thread and
must never be represented as a fake `Session`.

## Core shape

```text
ChatGPT parent
    |
    | upstream correlation identity
    v
OXP Parent Activity
    |
    +-- Observation segment
    |    +-- Observed tool epoch
    |         +-- invocation span
    |         +-- invocation span
    |         +-- continuity marker
    |
    +-- causal links
         +-- native Session
         +-- delegated worker Session
         +-- Scheduled Task
         +-- OXP process
         +-- approved root
         +-- external MCP capability
         +-- file transfer
```

## Non-goals

- Do not ingest or reconstruct ChatGPT conversation text.
- Do not infer user prompts from tool activity.
- Do not mint a backing OpenFork Session for the ChatGPT parent.
- Do not persist arbitrary raw MCP arguments or responses.
- Do not make historical activity state an authorization source.
- Do not hydrate workspaces merely to list parent activities.
- Do not make sidebar rows depend on invocation-history scans.

## Documents

- [Architecture](./01-architecture.md)
- [Durable data model](./02-data-model.md)
- [Producer, privacy, and safe projection contract](./03-producer-privacy.md)
- [UX and navigation](./04-ux.md)
- [Implementation and verification plan](./05-implementation-verification.md)

## Gate P acceptance summary

Gate P is closed only when:

1. parent activity is durable and globally inspectable without any workspace
   bootstrap;
2. the upstream correlation identifier is never persisted raw;
3. each OXP call has a durable invocation span with truthful terminal outcome;
4. concurrency is represented as overlapping spans rather than fake sequential
   messages;
5. native resource links are durable and bidirectional where the resource model
   supports provenance;
6. sidebar/list reads are O(1) materialized summary reads;
7. rich invocation history is paginated and only loaded for the opened activity;
8. restart recovery truthfully settles orphaned spans without claiming rollback;
9. the UI has no composer and cannot imply that OpenFork can message the upstream
   ChatGPT parent;
10. deletion/archive of activity history never deletes native resources;
11. Gate N installed-runtime conformance proves the documented
    `openai/session` metadata is forwarded on the packaged path and the observed
    parent-tool epoch behavior still matches reality; Gate P never fabricates a
    fallback conversation identity.
