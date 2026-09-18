# V2 git/Vcs surface — 'Open repository' backend design

**Status:** DESIGN ONLY — no repo code was modified to produce this document. All file:line
refs are from the working tree (branch `openfork`) at time of writing and were re-verified
after the store reset.
**Author:** coremith (t8) — backend design for the 'Open repository' tab context-menu action
(pathfinder's P3, docs/swarm-tab-project-actions.md §6/§9).
**Inputs:** docs/swarm-tab-project-actions.md (pathfinder §1-§9, uxsmith §10), source refs below.
**Companion:** critic's t7 cross-doc review (docs/swarm-cross-doc-review.md) ruled this plan
consistent with the V1-first contract — no corrections needed.

---

## 0. Source verification of pathfinder's v1-first refs

Every ref pathfinder flagged was re-checked against the working tree. All hold, with two
additions:

| Ref | Verified |
|---|---|
| `packages/opencode/src/project/vcs.ts:240-244` — `Vcs.Info = { branch?, default_branch? }`, no `remote` | ✅ current |
| `packages/app/src/utils/server-compat.ts:333-338` — `vcs.get` commented out | ✅ current; note the whole `vcs` namespace spread `...input.current.vcs` and overrides `status`/`diff` at :339-358 remain ACTIVE |
| `packages/opencode/src/git/index.ts:156-162` — `primary()` picks origin/single/upstream/first | ✅ current, but NOT on the public `Interface` (git/index.ts:75-91) — see §6 |
| `packages/opencode/src/cli/cmd/github.handler.ts:218` — `git remote get-url origin` pattern | ✅ current |
| `packages/opencode/src/server/routes/instance/httpapi/groups/instance.ts:83-93` — `instance.vcs` endpoint; handler `getVcs` at `handlers/instance.ts:40-45` returns `{ branch, default_branch }` | ✅ current |
| `packages/core/src/git.ts:205-209` — `Git.remote.get(repository, "origin")` → `git remote get-url`; non-zero exit → `undefined` | ✅ current; on the public `Interface` at git.ts:79-81 |
| `packages/core/src/project.ts:110-122` — `ProjectV2.resolve()` runs `git.remote.get` on every resolve, normalizes via `url()`/`parts()` (81-103), hashes into the project ID (73-79), then **discards** the normalized URL | ✅ current — this is the surface to expose |
| protocol has no git/vcs surface; `packages/client/src` has no vcs group | ✅ current — **but see the two additions below** |

**Addition 1 — the protocol vcs group existed and was removed.** `git log` shows
`packages/protocol/src/groups/vcs.ts` lived until `42e8d11552` (`feat(vcs): expose branch
info`) with endpoints `vcs.get` → `GET /api/vcs` → `Location.response(Vcs.Info)`,
`vcs.status`, `vcs.diff` (backed by `@opencode-ai/schema/vcs`, also since deleted). It is
absent from both `origin/dev` and `openfork` today. The app's vendored build of
`@opencode-ai/client` (packages/app/node_modules/@opencode-ai/client/dist) still carries that
stale generated group — `ServerApi["vcs"] = { status, diff }` — which is why the compat
layer's active `status`/`diff` overrides still typecheck. Consequences for this design:
- The new group is a **re-introduction, leaner than the historical one** — `remote` only. It
  must NOT ship `status`/`diff`: the V2 core has no Vcs service today (core/src has only
  `git.ts`; status/diff would need a whole new core service), and the app's status/diff
  compat overrides route to the legacy v1 surface anyway.
- After `bun run generate`, `ServerApi["vcs"]` becomes `{ remote }` — the compat layer's
  status/diff overrides must be re-typed against a local shape (§5). This is the one
  migration gotcha.

**Addition 2 — one protocol group + one handler serves BOTH server types.** The v1 opencode
server mounts the same V2 protocol `Api` with the same `@opencode-ai/server` handlers:
`packages/opencode/src/server/routes/instance/httpapi/server.ts:181-185`
(`HttpApiBuilder.layer(Api).pipe(Layer.provide(handlers), …)`) and provides `ProjectV2.node`
at :272. So a new `VcsGroup` registered in `makeApiFromGroup` + a handler in
`@opencode-ai/server/handlers` is reachable on v1 and v2 servers alike — the "v2 mirror" is
not v2-only.

---

## 1. Design summary

One new V2 protocol endpoint, one handler, one additive field on a core result, one compat
method re-enabled:

```
GET /api/vcs/remote?location[directory]=…            → { location, data: { remote?: string } }
```

- **Core**: `ProjectV2.Resolved` gains `remote?: string` — the browser-openable HTTPS URL,
  reconstructed server-side from the origin `ProjectV2.resolve` already fetches. Zero new
  subprocesses.
- **Protocol**: new `vcs` group (`packages/protocol/src/groups/vcs.ts`) with endpoint
  `vcs.remote`, location-scoped like the fs group.
- **Server**: one handler (`packages/server/src/handlers/vcs.ts`) that yields
  `ProjectV2.Service`, resolves `Location.Service.directory`, returns `{ remote }`.
- **Compat**: re-enable `compat.vcs.get` — v1 servers → extended legacy `instance.vcs`,
  v2 servers → `input.current.vcs.remote`. The menu never branches on protocol.
- **Events**: none — one-shot lazy fetch (§7).

The wire contract from pathfinder §6.4 holds: both surfaces return a browser-openable HTTPS
URL; P3 (`platform.openExternal`) opens the received value as-is, no client-side rewriting.
The item is hidden until the fetch resolves; stays hidden when the project is not git or has
no remote.

---

## 2. Core — `ProjectV2.Resolved.remote`

### 2.1 Additive field

`packages/core/src/project.ts:30-35`:

```ts
export interface Resolved {
  readonly previous?: ID
  readonly id: ID
  readonly directory: AbsolutePath
  readonly vcs?: Vcs
  readonly remote?: string   // NEW — browser-openable HTTPS URL of the primary remote
}
```

Purely additive — no consumer breaks (verified consumers: `core/src/location.ts`,
`core/src/session.ts`, `core/src/control-plane/move-session.ts`; all read existing fields).

### 2.2 Hoist the origin fetch, derive both ID and URL

Today `remote()` (project.ts:73-79) fetches the origin, normalizes, hashes. `resolve()`
(110-122) calls it. Change: hoist the origin fetch out of `remote()` so one
`git remote get-url origin` subprocess yields both the persisted ID (unchanged) and the URL:

```ts
const resolve = Effect.fn("Project.resolve")(function* (input: AbsolutePath) {
  const repo = yield* git.repo.discover(input)
  if (!repo) return { id: ID.global, directory: AbsolutePath.make(path.parse(input).root), vcs: undefined }

  const previous = yield* cached(repo.commonDirectory)
  const origin = yield* git.remote.get(repo)             // one subprocess (git.ts:205-209)
  const normalized = origin ? url(origin) : undefined    // "host/path" — drives the ID, UNCHANGED
  const id = (normalized ? ID.make(Hash.fast(`git-remote:${normalized}`)) : undefined)
    ?? previous
    ?? (yield* root(repo))
  return {
    previous,
    id: id ?? ID.global,
    directory: repo.worktree,
    vcs: { type: "git" as const, store: repo.commonDirectory },
    remote: origin ? webUrl(origin) : undefined,         // NEW — full HTTPS URL
  }
})
```

`url()`/`parts()` (project.ts:81-103) are **untouched byte-for-byte**: the project-ID hash
is persisted state (`git-remote:<host/path>` feeds `ID`), so its output must not change.

### 2.3 The URL reconstruction — `webUrl(input)` (reviews pathfinder's §6.4 port edge case)

Pathfinder accepted "parts() strips scheme/port, so remotes on non-default git hosts lose
the port" as OK. Review ruling: **fix it for http(s) remotes, keep dropping for
scp/ssh/git remotes.** The git-over-ssh port is never the web port, so `ssh://git@h:2222/…`
must NOT reconstruct `https://h:2222/…`; but a real `https://gitlab.example.com:8443/org` —
a common self-hosted layout — loses the port today and would open the wrong site.

```ts
function webUrl(input: string): string | undefined {
  const value = input.trim()
  if (!value) return undefined
  const clean = (name: string) =>
    name.replace(/^\/+/, "").replace(/\.git\/?$/, "").replace(/\/+$/, "")
  try {
    const parsed = new URL(value)
    if (parsed.protocol === "file:") return undefined
    const pathname = clean(parsed.pathname)
    if (!pathname) return undefined
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const port = parsed.port ? `:${parsed.port}` : ""
      return `https://${parsed.hostname}${port}${pathname.startsWith("/") ? "" : "/"}${pathname}`
    }
    return `https://${parsed.hostname}/${pathname}`   // ssh://, git:// — drop the port
  } catch {
    const scp = value.match(/^([^@/:]+@)?([^/:]+):(.+)$/)
    if (!scp) return undefined
    const pathname = clean(scp[3])
    return pathname ? `https://${scp[2].toLowerCase()}/${pathname}` : undefined
  }
}
```

Rules (same corpus as `url()`/`parts()` so both agree on what counts as a remote):
- `https://github.com/org/repo.git` → `https://github.com/org/repo` (`.git` stripped).
- `git@github.com:org/repo.git` (scp) → `https://github.com/org/repo` (lowercased host).
- `ssh://git@gitlab.example.com:2222/org/repo.git` → `https://gitlab.example.com/org/repo`
  (ssh port dropped — it is not the web port).
- `https://gitlab.example.com:8443/org/repo.git` → `https://gitlab.example.com:8443/org/repo`
  (https port **preserved** — the §6.4 fix).
- `file:///srv/repo` → undefined; unparseable (no scheme, no `host:path` scp form) →
  undefined (project treated as no-remote).

`webUrl` is a pure function next to `url()`/`parts()` — no Effect, per the opencode Effect
rules (synchronous parsing stays synchronous). The `remote()`/`resolve()` refactor is the
only behavioral change in core.

---

## 3. Protocol group

New file `packages/protocol/src/groups/vcs.ts`, following the location-scoped pattern of
`groups/fs.ts` (LocationQuery + `locationQueryOpenApi` + OpenApi annotations) and the
historical (deleted) vcs group:

```ts
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"

const VcsRemote = Schema.Struct({
  remote: Schema.optional(Schema.String),
}).annotate({ identifier: "Vcs.Remote" })

export const VcsGroup = HttpApiGroup.make("server.vcs").add(
  HttpApiEndpoint.get("vcs.remote", "/api/vcs/remote", {
    query: LocationQuery,
    success: Location.response(VcsRemote),
  })
    .annotateMerge(locationQueryOpenApi)
    .annotateMerge(
      OpenApi.annotations({
        identifier: "v2.vcs.remote",
        summary: "Resolve git remote URL",
        description:
          "Resolve the primary git remote of the requested location as a browser-openable HTTPS URL. Absent when the project is not git or has no remote.",
      }),
    ),
)
```

- **Query**: `LocationQuery` (`location: { directory?, workspace? }`) — not a bare
  `directory` param. Matches the fs group and the historical vcs group; the location
  middleware (`server/src/location.ts`) resolves workspace→directory and binds
  `Location.Service`.
- **Output schema is protocol-local** (`Vcs.Remote`), like `SessionActive` in
  `groups/session.ts:83-85`. The historical `@opencode-ai/schema/vcs` module is not
  resurrected for a single-use wire shape (rejected alternative: recreate
  `packages/schema/src/vcs.ts` — no second consumer today).
- **One endpoint, not three**: `status`/`diff` are NOT restored (no core V2 Vcs service;
  app status/diff stay v1-legacy-routed, §5).

Register in `packages/protocol/src/api.ts` `makeApiFromGroup` (after `FileSystemGroup`,
line 51):

```ts
.add(VcsGroup.middleware(locationMiddleware))
```

Protocol change → run `bun run generate` from `packages/client` (AGENTS.md).

---

## 4. Server handler

New file `packages/server/src/handlers/vcs.ts`, mirroring `handlers/fs.ts`:

```ts
import { Location } from "@opencode-ai/core/location"
import { ProjectV2 } from "@opencode-ai/core/project"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

export const VcsHandler = HttpApiBuilder.group(Api, "server.vcs", (handlers) =>
  Effect.gen(function* () {
    return handlers.handle("vcs.remote", () =>
      response(
        Effect.gen(function* () {
          const project = yield* ProjectV2.Service
          const location = yield* Location.Service
          const resolved = yield* project.resolve(location.directory)
          return { remote: resolved.remote }
        }),
      ),
    )
  }),
)
```

- `Location.Service` is in handler scope because the group is added with
  `.middleware(locationMiddleware)` (§3); `response()` (server/src/location.ts:15-27) wraps
  `{ location, data }` and also relies on it.
- `ProjectV2.Service` is a global core node — provided by both servers (opencode
  server.ts:272; the standalone packages/server core layer).
- Register in `packages/server/src/handlers.ts`: import + add `VcsHandler` to the
  `Layer.mergeAll(...)` list. Both servers pick it up via their existing `handlers` merge —
  no changes in packages/opencode for the V2 route.

---

## 5. App compat layer — the single client entry point

Re-enable `compat.vcs.get` (server-compat.ts:333-338). The menu calls
`api.vcs.get({ location: { directory } })` and reads `result.data.remote` — never branches
on protocol.

### 5.1 Type widening (required after regen)

After `bun run generate`, `ServerApi["vcs"]` = `{ remote }` (the stale vendored dist's
`{ status, diff }` disappears). The compat layer currently types its vcs namespace against
`ServerApi["vcs"]["status"]`/`["diff"]` (active at :339/:343) — those must move to a local
shape. Mirror the session/permission pattern (`CompatibleApi`, :38-41):

```ts
type CompatibleVcsApi = ServerApi["vcs"] & {
  get: (input?: { location?: { directory?: string } }) => Promise<{
    location: { directory: string }
    data: { branch?: string; defaultBranch?: string; remote?: string }
  }>
  status: (input?: { location?: { directory?: string } }) => Promise<VcsStatusOutput>   // locally re-typed
  diff: (input: { location: { directory?: string }; mode: "working" | "branch"; context?: number }) => Promise<VcsDiffOutput>
}

export type CompatibleApi = Omit<ServerApi, "session" | "permission" | "vcs"> & {
  readonly session: CompatibleSessionApi
  readonly permission: CompatiblePermissionApi
  readonly vcs: CompatibleVcsApi
}
```

**The vanishing-types scope expansion (critic t7 review, confirmed §11.1).** Regen removes
more than the two method signatures: `FileDiffInfo`, `VcsFileStatus`, `VcsStatusOutput`,
`VcsDiffOutput` exist only in the stale vendored dist
(packages/app/node_modules/@opencode-ai/client/dist/promise/generated/types.d.ts) — zero
references in protocol/schema/core/server — so they vanish from `@opencode-ai/client` after
regen. `FileDiffInfo` is imported from `@opencode-ai/client/promise` in **11 app files**
(verified; critic counted 9 — the two `pages/session/v2/*` files add to it):
`utils/diffs.ts` (+test), `context/server-session.ts`, `context/global-sync/{types,
session-cache(+test),event-reducer}.ts`, `pages/session/{review-tab,session-side-panel}.tsx`,
`pages/session/v2/{review-panel-v2,review-diff-kinds}.tsx`. `SnapshotFileDiff`/`VcsFileDiff`
come from the legacy `@opencode-ai/sdk/v2` — unaffected. Fix:
- NEW `packages/app/src/utils/vcs-types.ts` — local byte-identical copies of
  `FileDiffInfo`, `VcsFileStatus`, `VcsStatusOutput`, `VcsDiffOutput`, taken from the stale
  dist's `.d.ts` **before** regen overwrites it.
- Repoint the 11 imports above at `@/utils/vcs-types` (mechanical).
- `CompatibleVcsApi.status/diff` reference the LOCAL `VcsStatusOutput`/`VcsDiffOutput` — not
  generated names (which will not exist post-regen).

### 5.2 createV1Api — vcs namespace

```ts
vcs: {
  ...input.current.vcs,                       // v2 servers: vcs.remote passthrough
  async get(value?: { location?: { directory?: string } }) {
    const result = await legacy(value?.location).vcs.get()     // extended Vcs.Info, §6
    return located(
      { branch: result.data?.branch, defaultBranch: result.data?.default_branch, remote: result.data?.remote },
      value?.location,
    )
  },
  // status / diff overrides unchanged in behavior; re-typed against CompatibleVcsApi (§5.1)
}
```

- **v1 server** → `legacy(location).vcs.get()` → extended `{ branch, default_branch,
  remote }` → projected to the `{ location, data: { branch, defaultBranch, remote } }`
  shape (the exact commented code + `remote`). Version-robust: a pre-update v1 server
  returns no `remote` → menu hides the item (graceful, §8).
- **v2 server** → `input.current.vcs.remote({ location })` → `{ location, data: { remote } }`
  as-is.
- **status/diff stay v1-legacy-routed** (behavior unchanged). Known pre-existing gap, not
  introduced here: on a pure v2 server they hit the legacy httpapi which the v2 server does
  not serve — the app's VCS status/diff view remains v1-only until a core V2 Vcs service
  exists.

Un-comment/extend the compat test at server-compat.test.ts:167-175 (it mocks GET `/vcs` →
`{ branch, default_branch }`) and add `remote` to the mock + expectation.

---

## 6. V1 side (pathfinder's v1-first, kept)

The v1 change ships with the menu so pre-update-servers degrade gracefully.

1. **Schema**: `packages/opencode/src/project/vcs.ts:240-244` — add
   `remote: Schema.optional(Schema.String)` to `Info` (no other consumer breaks; the
   instance endpoint already wraps it).
2. **Git service**: add `remoteUrl: (cwd: string) => Effect.Effect<string | undefined>` to
   the `@/git` `Interface` (git/index.ts:75-91) and implement in the layer: `primary(cwd)`
   (:156-162, already internal) then `run(["remote", "get-url", <name>], { cwd })` — the
   proven github.handler.ts:218 pattern, centralized. Non-zero exit or empty remote list →
   `undefined` (no throw). `primary()` itself is NOT on the Interface; wrapping it keeps the
   primary-selection rule in one place instead of duplicating it in the Vcs service.
3. **Vcs service**: add `remote: () => Effect.Effect<string | undefined>` to
   `Vcs.Interface` (project/vcs.ts:281-289) implemented as `git.remoteUrl(ctx.directory)`.
   **Deliberate deviation from the plan's "cached in the Vcs InstanceState":** compute
   per-call instead. The InstanceState caches branch state refreshed by the HEAD watcher
   (:319-331); remote changes via `.git/config` edits which the watcher never sees — a
   state cache would go stale with no refresh path. Two extra subprocesses per
   menu-open-rate call is cheap; the client cache (§7) bounds the rate.
4. **Handler**: `handlers/instance.ts:40-45` `getVcs` → include `remote`:
   `const [branch, default_branch, remote] = yield* Effect.all([vcs.branch(), vcs.defaultBranch(), vcs.remote()], …)`.
5. **Legacy SDK regen**: `packages/sdk/js/script/build.ts` (AGENTS.md) so
   `legacy().vcs.get()`'s `VcsGetData` carries `remote?` (sdk.gen.ts:419-429 today).

---

## 7. Fetch timing, cache/lifecycle, event story

**One-shot fetch — no event/stream surface.** Decision, with rationale:
- The remote URL changes only by manual `.git/config` edits — a rare, deliberate action.
- The menu fetches lazily on first menu open with the client cache from pathfinder P3
  (module-scoped in-memory map keyed by `pathKey(directory)`: 60s TTL positive, 30s TTL
  negative). Staleness after a remote change is bounded by that TTL, then self-corrects.
- An event story would require watching `.git/config` per open project — v1's watcher only
  fires for HEAD (project/vcs.ts:323), core has no config watcher. Cost without benefit.
- Both server routes compute fresh per call, so server-side staleness is zero.

**Server cache: none.** `ProjectV2.resolve` runs `discover` + `remote get-url`
(~2 subprocesses, KeyedMutex-serialized per git dir — git.ts:180-182) per call. At menu-open
rate this is negligible. Documented extension point if profiling ever disagrees: a
per-directory `Effect.cached`-with-TTL in the handler.

**Lifecycle:** the resolved value is not stored anywhere durable — it is a derived
property of the repo config, recomputed on demand. Nothing to invalidate or migrate.

---

## 8. Error handling

| Failure | Behavior |
|---|---|
| Not a git repo / no repo discovered | `resolve` returns global project → `remote: undefined` → 200 `{ data: {} }`; menu hides item, caches negative 30s |
| Git repo, no remotes | `git.remote.get` → `undefined` (core git.ts:207); v1 `primary()` → `undefined` on empty list → `remote: undefined` |
| Git subprocess failure (corrupt repo, permissions) | both surfaces return `undefined`, **never throw** (core git.ts:207; v1 `run` result check) |
| Malformed/unparseable remote URL | `webUrl`/`url` → `undefined` → no remote (ID falls back to previous/root — today's behavior, unchanged) |
| Deleted/moved worktree | `discover` → `undefined` → hidden. P1/P2 (path-based) unaffected |
| Transport failure (server unreachable) | menu fetch `.catch` → hide item + negative cache (pathfinder P3) |
| Old v1 server (no `remote` in Vcs.Info) | legacy route returns `remote: undefined` → hidden (graceful) |

No domain errors are declared on the endpoint (absent remote is a valid 200); the only
failure classes are transport/schema, handled by existing middleware. This is the
"no-remote is data, not error" contract the menu's hidden-item logic depends on.

---

## 9. Edge cases

| Case | Behavior |
|---|---|
| scp remote `git@github.com:org/repo.git` | `https://github.com/org/repo` |
| https remote with port `https://gitlab.example.com:8443/org` | `https://gitlab.example.com:8443/org` (port preserved — §2.3) |
| ssh remote `ssh://git@h:2222/org/repo.git` | `https://h/org/repo` (ssh port dropped) |
| linked worktree / submodule | resolves via the worktree's repo; `remote get-url` runs in the worktree — no `.git/config` parsing client-side (pathfinder §6.5 stands) |
| Remote changed mid-session | client cache shows old URL ≤60s, then self-corrects; no server staleness |
| Menu opened mid-fetch | item appears on resolution; cache makes subsequent opens instant (P3) |
| Draft tab (no session) | no fetch; project group not rendered (P3) |
| Project `id` stability | unchanged — `url()`/`parts()` output is byte-identical, ID hashing untouched (§2.2) |

---

## 10. Files that would change (implementation checklist)

Core:
1. `packages/core/src/project.ts` — `Resolved.remote?`; hoist origin fetch in `resolve()`;
   add `webUrl()` helper (§2).

Protocol (public surface → `bun run generate` from packages/client):
2. `packages/protocol/src/groups/vcs.ts` — NEW `VcsGroup` with `vcs.remote` (§3).
3. `packages/protocol/src/api.ts` — `.add(VcsGroup.middleware(locationMiddleware))`.

Server:
4. `packages/server/src/handlers/vcs.ts` — NEW handler (§4).
5. `packages/server/src/handlers.ts` — merge `VcsHandler`.

App:
6. `packages/app/src/utils/vcs-types.ts` — NEW local copies of the vanishing generated
   types (`FileDiffInfo`, `VcsFileStatus`, `VcsStatusOutput`, `VcsDiffOutput`) from the stale
   dist before regen (§5.1).
7. `packages/app/src/utils/server-compat.ts` — re-enable `vcs.get`; widen
   `CompatibleApi`/`CompatibleVcsApi` against the local vcs-types (§5).
8. Repoint the 11 `FileDiffInfo` imports at `@/utils/vcs-types` (§5.1): `utils/diffs.ts`
   (+test), `context/server-session.ts`, `context/global-sync/{types,session-cache(+test),
   event-reducer}.ts`, `pages/session/{review-tab,session-side-panel}.tsx`,
   `pages/session/v2/{review-panel-v2,review-diff-kinds}.tsx`.

V1 (ships with the menu):
9. `packages/opencode/src/project/vcs.ts` — `remote?` on `Info`; `remote()` on
   `Vcs.Interface` (§6).
10. `packages/opencode/src/git/index.ts` — `remoteUrl` on `Interface` + impl (§6).
11. `packages/opencode/src/server/routes/instance/httpapi/handlers/instance.ts` — `getVcs`
    includes `remote` (§6).
12. `packages/sdk/js/script/build.ts` — legacy sdk regen (§6).

Tests:
13. `packages/core/test/project.test.ts` — `webUrl` corpus (§2.3) + `resolve().remote`.
14. `packages/server/test/…` — `vcs.remote` endpoint (v2 shape `{ location, data: { remote } }`).
15. `packages/app/src/utils/server-compat.test.ts:167-175` — un-comment + extend with
    `remote` (v1 route) and a v2 passthrough case.

---

## 11. Open questions / risks

1. **Vanishing generated types on regen (MEDIUM — compile break, mechanical).** After
   `bun run generate`, `FileDiffInfo`/`VcsFileStatus`/`VcsStatusOutput`/`VcsDiffOutput` no
   longer exist in `@opencode-ai/client` (verified: only the stale vendored dist has them;
   nothing in protocol/schema/core/server generates them). Scope: `CompatibleVcsApi` §5.1
   signatures **and** 11 app files importing `FileDiffInfo` from `@opencode-ai/client/promise`
   (list in §5.1). Mitigation: NEW `packages/app/src/utils/vcs-types.ts` with byte-identical
   copies taken from the stale dist `.d.ts` (packages/app/node_modules/@opencode-ai/client/
   dist/promise/generated/types.d.ts) **before** regen overwrites it; repoint the 11 imports
   (mechanical). Copy, do not hand-retype — the shapes are load-bearing for the session_diff
   store and review UIs. After the repoint, the V2 route has no dependency on the generated
   vcs status/diff types.
2. **Self-hosted https-on-nonstandard-port** (LOW): preserved (§2.3). scp-style remotes can
   never carry a web port — orgs on non-443 web should use https-form remotes; documented.
3. **V2 `status`/`diff` remain unimplemented** (MEDIUM, pre-existing): the app's VCS
   status/diff compat overrides stay v1-only; a pure-v2 server already cannot serve them.
   This design does not change that. A future core V2 Vcs service could restore the full
   historical group (`vcs.status`/`vcs.diff`) on top of `vcs.remote`.
4. **Menu-only v1 (no palette command)** (none): per pathfinder §3.5, palette is optional
   follow-up; the endpoint is client-agnostic so TUI/CLI can adopt later.
