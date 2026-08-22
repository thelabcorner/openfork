# OpenFork

This repository is **OpenFork**: a branch-fork of [OpenCode](https://github.com/anomalyco/opencode) Desktop. It is not an independent product and it is not OpenChamber.

- Default branch: `main`
- Upstream: `upstream` → `https://github.com/anomalyco/opencode.git`
- Sync source: **release tags** (`v1.18.x`), not a floating `upstream/dev`
- Ownership map: `FORK.md`

This tree is desktop + sidecar only. Ignore and prune: console, stats, enterprise, slack, web, infra, TUI. Those paths are **not on `main`**. If a merge puts them back, `bun run fork:prune` — do not keep them. Do not maintain `packages/opencode/src/cli/tui`; take upstream there.

## Instruction order

1. This file.
2. `FORK.md` for remotes, KEEP/DROP, or conflict ownership.
3. Every matching skill under `.opencode/skills/`.
4. Nearest package `AGENTS.md`.
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

When debugging or verifying the desktop app, tell the user to run `bun run dev` from `packages/desktop` (not the packaged `.exe`). It launches Electron against current source with renderer hot-reload and a live main-process log stream. A packaged build reflects whatever commit it was built from. Renderer-only changes hot-reload; changes under `packages/desktop/src/main` need the dev process killed and relaunched.

## Workspace

Runtime dependencies stay directed from Schema to Core and Protocol, then from Core and Protocol to Server. Client runtime code may depend on Schema and Protocol but never Core or Server; `sdk-next` is out of the desktop workspace.

After changing the public Protocol or Server `HttpApi`, run `bun run generate` from `packages/client`. Do not edit `src/generated` or `src/generated-effect` directly. To regenerate the legacy JavaScript SDK, run `./packages/sdk/js/script/build.ts`.

## Branch names

Short, at most three words, hyphens, no `feat/` prefixes. Examples: `session-recovery`, `fix-scroll-state`.

## Commits and PR titles

`type(scope): summary`. Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`.

## Style Guide

### General Principles

- Keep things in one function unless composable or reusable
- Do not extract single-use helpers preemptively. Inline the logic at the call site unless the helper is reused, hides a genuinely complex boundary, or has a clear independent name that improves the caller.
- Avoid `try`/`catch` where possible
- Avoid using the `any` type
- Use Bun APIs when possible, like `Bun.file()`
- Rely on type inference when possible; avoid explicit type annotations or interfaces unless necessary for exports or clarity
- Prefer functional array methods (flatMap, filter, map) over for loops; use type guards on filter to maintain type inference downstream
- In `src/config`, follow the existing self-export pattern at the top of the file (for example `export * as ConfigAgent from "./agent"`) when adding a new config module.
- In Effect generators, bind services to named variables before calling methods. Do not use nested service yields such as `yield* (yield* Foo.Service).bar()`.

Reduce total variable count by inlining when a value is only used once.

```ts
// Good
const journal = await Bun.file(path.join(dir, "journal.json")).json()

// Bad
const journalPath = path.join(dir, "journal.json")
const journal = await Bun.file(journalPath).json()
```

### Destructuring

Avoid unnecessary destructuring. Use dot notation to preserve context.

```ts
// Good
obj.a
obj.b

// Bad
const { a, b } = obj
```

### Imports

- Never alias imports. Do not use `import { foo as bar } from "..."` or renamed imports like `resolve as pathResolve`.
- Never use star imports. Do not use `import * as Foo from "..."` or `import type * as Foo from "..."`.
- If a namespace-style value is needed, import the module's own exported namespace by name, for example `import { Project } from "@opencode-ai/core/project"`, then reference `Project.ID`.
- Prefer dynamic imports for heavy modules that are only needed in selected code paths, especially in startup-sensitive entrypoints. Destructure dynamic import bindings near the top of the narrowest scope that needs them so they read like normal imports. Avoid inline chains such as `await import("./module").then((mod) => mod.value())` or `(await import("./module")).value()`. Keep branch-specific imports inside the branch that needs them to preserve lazy loading.

### Variables

Prefer `const` over `let`. Use ternaries or early returns instead of reassignment.

```ts
// Good
const foo = condition ? 1 : 2

// Bad
let foo
if (condition) foo = 1
else foo = 2
```

### Control Flow

Avoid `else` statements. Prefer early returns.

```ts
// Good
function foo() {
  if (condition) return 1
  return 2
}

// Bad
function foo() {
  if (condition) return 1
  else return 2
}
```

### Complex Logic

When a function has several validation branches or supporting details, make the main function read as the happy path and move supporting details into small helpers below it.

```ts
// Good
export function loadThing(input: unknown) {
  const config = requireConfig(input)
  const metadata = readMetadata(input)
  return createThing({ config, metadata })
}

function requireConfig(input: unknown) {
  ...
}
```

- Keep helpers close to the code they support, below the main export when that improves readability.
- Do not over-abstract simple expressions into many single-use helpers; extract only when it names a real concept like `requireConfig` or `readMetadata`.
- Do not return `Effect` from helpers unless they actually perform effectful work. Synchronous parsing, validation, and option building should stay synchronous.
- Prefer Effect schema helpers such as `Schema.UnknownFromJsonString` and `Schema.decodeUnknownOption` over manual `JSON.parse` wrapped in `Effect.try` when parsing untrusted JSON strings.
- Add comments for non-obvious constraints and surprising behavior, not for obvious assignments or control flow.

### Schema Definitions (Drizzle)

Use snake_case for field names so column names don't need to be redefined as strings.

```ts
// Good
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})

// Bad
const table = sqliteTable("session", {
  id: text("id").primaryKey(),
  projectID: text("project_id").notNull(),
  createdAt: integer("created_at").notNull(),
})
```

## Testing

- Avoid mocks as much as possible, you shouldn't be using globalThis.\* at all unless it's the only option.
- Test actual implementation, do not duplicate logic into tests
- Tests cannot run from repo root (guard: `do-not-run-tests-from-root`); run from package dirs like `packages/opencode`.

## Type Checking

- Always run `bun typecheck` from package directories (e.g., `packages/opencode`), never `tsc` directly.

## API Architecture

- Treat the V1 legacy API as the production app surface unless a task explicitly says it is for V2. Desktop, app workflows, tab actions, settings flows, and user-facing session behavior should be designed and verified against the V1 HTTP API and its SDK shape first.
- V2 APIs and `SessionV2` are beta/incomplete infrastructure. Use them only for code paths that are already V2-owned or for explicitly scoped V2 work. Do not migrate V1 product behavior onto V2 endpoints just because a V2 type or client exists.
- When adding user-facing session features, prefer V1 route groups and handlers under `packages/opencode/src/server/routes/instance/httpapi`, V1 session services such as `SessionPrompt`/`Session`, and the legacy JavaScript SDK regeneration path. Keep V2 additions separate unless the feature requires both surfaces.
- If a feature is exposed through the app or desktop today, verify the packaged desktop build against the same V1 endpoint the UI calls. Local Vite success is not enough when the EXE bundles generated clients and server code.
- Keep naming clear in comments and docs: "V1" means the current legacy production API; "V2" means the newer beta session/core API. Avoid referring to shared UI components as V2 API behavior just because their component names include `V2`.

## V2 Session Core

- Keep durable prompt admission separate from model execution. `SessionV2.prompt(...)` admits one durable `session_input` row before scheduling advisory `SessionExecution.wake(sessionID)` unless `resume: false` requests admit-only behavior. The serialized runner promotes admitted inputs into visible user messages at safe boundaries.
- Reusing a Session ID adopts the existing Session. Reusing a prompt message ID reconciles an exact retry only when Session, prompt, and delivery mode match; conflicting reuse fails. Historical projected prompts lazily synthesize promoted inbox records during exact retry.
- Keep `SessionExecution` process-global and Session-ID based. Its local implementation owns the process-local Session coordinator and discovers placement through `SessionStore` plus `LocationServiceMap.get(session.location)` only when a drain starts; no layer should take a Session ID. V2 interruption targets the active process-local ownership chain for that Session; idle or missing interruption is a no-op.
- Keep `SessionRunner`, model resolution, tool registry, permissions, and filesystem Location-scoped. Omitted `Location.workspaceID` means implicit-local placement; explicit workspace identity remains reserved for future placement semantics.
- Preserve one explicit `llm.stream(request)` call per provider turn and reload projected history before durable continuation. Do not bridge through legacy `SessionPrompt.loop(...)` or delegate orchestration to an in-memory tool loop.
- Keep local Session drains process-local until clustering is implemented. `SessionRunCoordinator` joins explicit same-Session resumes, coalesces prompt wakeups, and allows different Sessions to run concurrently. Advisory wakes drain eligible durable inbox rows only; post-crash continuation recovery requires a separate explicit design before it may retry provider work. A drain has no durable identity or transcript boundary.
- Keep delivery vocabulary explicit. Prompts steer by default and promote at the next safe provider-turn boundary while the current drain requires continuation. An explicit `queue` input remains pending until the Session would otherwise become idle; promote one queued input at that boundary, then reevaluate continuation before promoting another. Promoting any new user input resets the selected agent's provider-turn allowance; a batch of steers resets it once.
- Keep EventV2 replay owner claims separate from clustered Session execution ownership.
- Keep the System Context algebra, registry, and built-ins in `src/system-context`; keep Context Source producers with their observed domains, and keep Session History selection plus Context Epoch persistence Session-owned.
