# T6 — HTTP API (split by ownership tier)   SDK regeneration

**Depends on:** T3  
**Blocks:** T8  
**Read first:** `04-surface-and-ux.md` § 1; the httpapi `AGENTS.md`

## Scope

Two groups, one noun — exactly as 04 § 1 specifies. The `scheduledTask`
group is Tier 0 and must **not** carry `InstanceContextMiddleware`. Only
`runNow` lives in the Tier 3 group.

Before writing any endpoint, complete the 7-point route review checklist
from the httpapi `AGENTS.md` and paste the answers into the PR
 description. That checklist exists precisely for cases like this one.

## Rules

- Follow the established group pattern: yield services once while building
  the handler layer, close over them in endpoint implementations.
- Declare explicit `Schema.ErrorClass` error contracts per endpoint. Do
not
  leak domain or storage errors through the handler boundary.
- Keep the core service free of any HttpApi types.
- `preview` is pure and touches no database.

## SDK

**Regenerate the SDK and commit the result.** The generated client is
not hand-edited. T6 is not complete until the generated types exist and
the workspace typechecks — T8 depends on them existing, not on them
being planned.

## Verification

- D1 and D2 from 05: instance-load probe reads **zero** for every
endpoint
  in the Tier 0 group, including when directory/workspace query
  parameters are omitted.
- OpenAPI output includes both groups with correct error schemas.
