# T7 — Verify desktop

**Lane:** verifier  
**After:** T3 T4 T5 T6  
**Unlocks:** T8

## Do

```powershell
bun install
bun --cwd packages/opencode typecheck
bun --cwd packages/app typecheck
bun --cwd packages/desktop typecheck
```

If typecheck fails because a KEEP package imports a dropped workspace member, **put that member back on the allowlist**. Do not stub.

Then tell the human to run:

```powershell
bun run --cwd packages/desktop dev
```

Smoke: window opens, sidecar healthy, a session opens, tab chrome / explorer still look like the fork.

`git ls-files packages/console packages/web infra sst.config.ts` must be empty. Grep `node_modules` for console/stats/web/enterprise — should be absent.

## Do not

Fix unrelated product bugs. Restart loops. Claim success from typecheck alone.

## Done when

Typecheck of the three packages is clean. Human confirms the window. Install graph is slim.

No commit required unless you had to restore a workspace member — then amend T5 with a follow-up `chore: keep <pkg> on workspace allowlist`.
