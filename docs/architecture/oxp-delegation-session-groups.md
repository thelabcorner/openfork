# OXP delegated-worker grouping: producer-owned session identity

## Bottom-up owner map

1. **Authoritative producer:** MCP ingress supplies `openai/session` as an
   optional ChatGPT conversation correlation. The OXP status handshake stores its
   normalized `sessionTitle` on the canonical Core OXP parent-activity record.
   No fake OpenFork Session represents a ChatGPT conversation.
2. **Durable identity and read:** Core `OxpActivity.sessionTitle` reads the
   indexed correlation reference joined to the parent-activity title; the OXP
   activity recorder pseudonymizes the ingress key, carries only digest/title
   to the worker creation boundary, and retains the digest if title read fails.
   No message history hydration, per-row timer, or InstanceStore load is needed.
3. **Pure group projection:** `packages/core/src/oxp-activity/delegation-group.ts`
   maps a trusted `principalRef + pseudonymized conversation digest` into
   a stable group identity and derived display title. The title and root are not
   part of the identity. Without a correlation, legacy connector/root groups
   remain unchanged.
4. **Durable group owner:** `SessionGroup.resolveOrCreate` is the only writer
   for the originating-session group and reconciles verified title updates,
   while ignoring provisional title fallbacks. Membership and lineage remain
   locked, durable native Session/SessionGroup edges. OXP is a narrow adapter;
   no frontend heuristic reconstructs ownership from worker titles.
5. **Projection and UI:** existing group list/detail events, SDK, and home
   navigation already consume persisted SessionGroup identities and names;
   no new client cache, endpoint or view-layer grouping function exists.

## Identity, lifetime, security

A group name is display metadata, never a principal or authorization token.
The correlation digest is produced by the existing OXP pseudonymizer; raw
ChatGPT conversation IDs do not enter group keys or Session metadata. OXP
delegation authority, approved-root admission, explicit worker model/agent
selection, runtime guards and cancellation semantics are unchanged.
SessionGroup persistence is the group owner; activity is *only* identity/title
provenance, not an execution lease. Group ids survive restarts and title edits.

A `batch_start` continues to create its own durable batch group/handle with
separate lifecycle and compensation semantics. It is not silently collapsed into
a session group: doing so would change the batch control contract. A distinct
session-level navigation projection for batch members requires explicitly
modelling both relationships and preventing duplicate home listings. Historical
legacy connector/root workers are not migrated without provenance evidence.

## Verification

- Core pure projection tests: distinct conversations, title changes, root
  changes, absent title and legacy calls.
- Core persistent activity lookup: no creation on read, one canonical parent
  row, renamed title visible, wrong digest has no title.
- V1 SessionGroup integration: persisted group rename under stable ID,
  membership intact, missing title does not downgrade.
- OXP control, MCP transport, and native group regression tests.
- Core and OpenFork typechecks; no production connector restart or live
  delegated-provider execution is implied by these tests.
