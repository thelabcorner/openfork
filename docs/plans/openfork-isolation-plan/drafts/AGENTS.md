# OpenFork

This repository is **OpenFork**: a branch-fork of [OpenCode](https://github.com/anomalyco/opencode) Desktop. It is not an independent product and it is not OpenChamber.

- Default branch: `main`
- Upstream: `upstream` → `https://github.com/anomalyco/opencode.git`
- Sync source: **release tags** (`v1.18.x`), not a floating `upstream/dev`
- Ownership map: `../../../../FORK.md`

This tree is desktop + sidecar only. Ignore and prune: console, stats, enterprise, slack, web, infra, TUI. Those paths are **not on `main`**. If a merge puts them back, `bun run fork:prune` — do not keep them. Do not maintain `../../../../packages/opencode/src/cli/tui`; take upstream there.

## Instruction order

1. This file.
2. `../../../../FORK.md` for remotes, KEEP/DROP, or conflict ownership.
3. Every matching skill under `../../../../.opencode/skills`.
4. Nearest package `../../../handoff/AGENTS.md`.
5. Local code precedent.

If these conflict, stop. Do not silently pick one.

## Skills

| Trigger | Skill |
|---|---|
| Merge, cherry-pick, or rebase involving `upstream`, a `v*.*.*` tag, or an anomalyco PR | `upstream-sync` |
| Effect v4 / effect-smol | `effect` |
| RTL/LTR, desktop chrome, mixed-direction text | `rtl-aware-development` |

Load `upstream-sync` before any git operation that brings upstream code in. Do not use `-X ours` / `-X theirs`. Do not `filter-repo`. Do not rebase `main` onto `upstream/dev`.

## Desktop

When debugging or verifying the desktop app, tell the user to run `bun run dev` from `../../../../packages/desktop` (not the packaged `.exe`). It launches Electron against current source with renderer hot-reload and a live main-process log stream. A packaged build reflects whatever commit it was built from. Renderer-only changes hot-reload; changes under `../../../../packages/desktop/src/main` need the dev process killed and relaunched.

## Workspace

Runtime dependencies stay directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` is out of the desktop workspace.

After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `../../../../packages/client`. Do not edit `src/generated` or `src/generated-effect` directly. To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.

## Branch names

Short, at most three words, hyphens, no `feat/` prefixes. Examples: `session-recovery`, `fix-scroll-state`.

## Commits and PR titles

`type(scope): summary`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

## Style guide

### General principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively
- Avoid `try`/`catch` where possible
- Avoid the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference; avoid explicit annotations unless needed for exports
- Prefer functional array methods; use type guards on filter
- In `src/config`, follow the existing self-export pattern (`export * as ConfigAgent from "./agent"`)
- In Effect generators, bind services to named variables before calling methods. Do not write `yield* (yield* Foo.Service).bar()`

Reduce total variable count by inlining when a value is only used once.

```ts
const journal = await Bun.file(path.join(dir, "journal.json")).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation.

### Imports

- Never alias imports
- Never use star imports
- If a namespace value is needed, import the module's own exported namespace
- Prefer dynamic imports for heavy modules only needed on selected paths

### Variables

Prefer `const`. Use ternaries or early returns instead of reassignment.

### Control flow

Avoid `else`. Prefer early returns.

### Complex logic

Happy path in the main function; supporting details in small helpers below it. Do not return `Effect` from helpers unless they are effectful. Prefer Effect schema helpers over manual `JSON.parse`.

### Schema definitions (Drizzle)

Use snake_case field names so column names do not need to be redefined as strings.

## Testing

- Avoid mocks. Do not use `globalThis.*` unless it is the only option.
- Test actual implementation
- Tests cannot run from repo root. Run from package dirs like `../../../../packages/opencode`.

## Type checking

Always run `bun typecheck` from package directories. Never `tsc` directly.

## API architecture

- Treat the V1 legacy API as the production app surface unless a task explicitly says it is for V2.
- V2 APIs and `SessionV2` are beta. Do not migrate V1 product behavior onto V2 endpoints just because a V2 type exists.
- When adding user-facing session features, prefer V1 route groups under `../../../../packages/opencode/src/server/routes/instance/httpapi`, V1 session services, and the legacy JavaScript SDK regeneration path.
- Verify packaged desktop against the same V1 endpoint the UI calls. Local Vite success is not enough.
- "V1" means the current production API. "V2" means the newer beta session/core API. A component name containing `V2` is not a V2 API.

## V2 session core

- Keep durable prompt admission separate from model execution.
- Reusing a Session ID adopts the existing Session. Conflicting prompt-id reuse fails.
- Keep `SessionExecution` process-global and Session-ID based.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped.
- Preserve one explicit `llm.stream(request)` call per provider turn.
- Keep local Session drains process-local until clustering exists.
- Keep delivery vocabulary explicit (steer vs queue).
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra in `src/system-context`.
