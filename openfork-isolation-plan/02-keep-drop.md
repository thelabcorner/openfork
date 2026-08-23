# 02 — Keep / Drop Inventory

> **STATUS: COMPLETE** — traced from `packages/desktop` → `prebuild.ts` → `opencode/script/build-node.ts` → workspace deps. Machine-readable copy: `drafts/keep-manifest.json`.

## How desktop actually boots

```
packages/desktop   bun run dev | bun run build
  predev / prebuild
    → copy-icons, copy-metainfo
    → cd ../opencode && bun script/build-node.ts
         Bun.build({ target: "node", entry: src/node.ts, out: dist/node })
    → (dev channel only) download Rust CLI binary ~176 MB
  electron-vite
    main     = packages/desktop/src/main
    renderer = @opencode-ai/app  (packages/app)
    sidecar  = utilityProcess.fork → dist/node/node.js → Server.listen
```

Default sidecar is **V1 Node**. `OPENCODE_SIDECAR_V2=1` is opt-in and needs the downloaded CLI. A personal fork can ignore V2.

`build-node.ts` freshness roots: `packages/opencode/src`, `packages/opencode/script`, `packages/core/src`, `packages/protocol/src`, `packages/plugin/src`, `bun.lock`.

## KEEP — required to build and run desktop

| Path | Why |
|---|---|
| `packages/desktop` | Electron shell |
| `packages/app` | Renderer |
| `packages/ui` | Design system |
| `packages/session-ui` | Timeline / tool cards |
| `packages/opencode` | Sidecar server |
| `packages/core` | DB, PTY, tools, search; root `postinstall` |
| `packages/schema` | Shared contracts |
| `packages/protocol` | HTTP API |
| `packages/server` | `Server.listen` |
| `packages/plugin` | Plugin loader |
| `packages/llm` | Sidecar model runtime |
| `packages/codemode` | Sidecar tool |
| `packages/sdk/js` | Legacy SDK the UI still speaks |
| `packages/script` | `Script.version` / channel in `build-node.ts` |
| `packages/effect-drizzle-sqlite` | core DB |
| `packages/effect-sqlite-node` | Node sqlite (sidecar is Node, not Bun) |
| `package.json` `bun.lock` `bunfig.toml` `tsconfig.json` `patches/` | workspace |

## OPTIONAL KEEP — not needed for `bun run dev`, needed for a mergeable fork

| Path | Why |
|---|---|
| `packages/client` | Runtime UI uses a **vendored tgz**. Workspace client is for `bun run generate` after protocol merges. **Keep.** |
| `packages/httpapi-codegen` | Only used by client generate. Keep with client. |
| `packages/http-recorder` | Test VCR only. Keep if you run opencode/core tests. |
| `packages/tui` | **Do not keep.** Inline `record` / `error` / `locale` into `packages/opencode/src/util`, drop the workspace dep, `git rm packages/tui`. Do not strip `packages/opencode/src/cli/tui`. |
| `turbo.json` | Root typecheck only |
| `.husky` oxlint prettier | Quality |
| `script/sign-windows.ps1` | Windows packaging |
| `script/translate-app.ts` | i18n |
| `docs/desktop-build-and-architecture.md` | Useful; most other `docs/` is design notes |

## DROP FROM `main` — `git rm` these (history keeps them)

| Path | Why it is clutter |
|---|---|
| `packages/console/**` | SaaS billing/auth/lander (~48 MB) |
| `packages/stats/**` | Public stats / Athena / R2 |
| `packages/enterprise` | Teams app |
| `packages/function` | `api.opencode.ai` worker |
| `packages/slack` | Slack bot |
| `packages/web` | Marketing/docs site (~12.5 MB) |
| `packages/storybook` | Storybook |
| `packages/cli` | Experimental `lildax` CLI, not the desktop sidecar |
| `packages/sdk-next` | No desktop/app/opencode runtime importer |
| `packages/docs` `packages/identity` `packages/containers` | Not even workspace members |
| `sst.config.ts` `sst-env.d.ts` `infra/` | SST / AWS / Stripe / PlanetScale |
| `github/` `sdks/vscode/` | GH Action + VS Code extension |
| anomalyco `.github/workflows` publish/deploy/stats/docs | Will fail here |
| `script/publish.ts` `script/release` `script/beta.ts` `script/stats.ts` | Their release machine |
| Root `sso` `dev:console` `dev:stats` `@aws-sdk/client-s3` | SaaS |

These paths are removed from `main` with `git rm` (see `drafts/scripts/fork-prune.ts`). History keeps them. After every tag merge, prune again.

## UNCERTAIN — do not decide in phase 1

| Path | Question |
|---|---|
| `@opentui/*` still listed on `opencode` | Fine — CLI TUI code stays in the sidecar package unmaintained. Do not rip those imports out. |
| Rust CLI download in `prebuild.ts` | Skip if you stay V1-only (saves 176 MB) |
| Interactive `opencode` CLI entry | Same package as the sidecar — never drop the package |

`flake.nix` / `nix/` — **prune**. Not needed for Windows Electron.

## PRUNE FROM THE FIRST PUSH (local junk, not product)

Do not publish:

- `.opencode/swarms/swarms.chunkdb*`
- `_archivetest/`, `packages/opencode/sample.db`
- `packages/app/.vite-*.log`, `cdp-*.png`, `scripts/cdp-*.mjs`
- `packages/app/vendor/opencode-ai-client-*.tgz` if it is already a committed vendor — check before deleting; the package.json points at it
- `backup-graphic-design*.ps1`, `dedupe-graphic-design.ps1`
- `packages/core/dbg.tmp.ts`, `*.bak`, `electron.vite.config.*.mjs`
- `t3code-handoff.md`, `shingle-test.ts`, `stdin-verify.ts` unless you still want them
- `startup-investigation/` — optional keep as notes, do not need it on GitHub

`swarm-port-plan/` and **this folder** may stay as planning docs or move later. Your call.

## Target workspace allowlist

Replace the glob in root `package.json`:

```json
"workspaces": {
  "packages": [
    "packages/app",
    "packages/client",
    "packages/codemode",
    "packages/core",
    "packages/desktop",
    "packages/effect-drizzle-sqlite",
    "packages/effect-sqlite-node",
    "packages/http-recorder",
    "packages/httpapi-codegen",
    "packages/llm",
    "packages/opencode",
    "packages/plugin",
    "packages/protocol",
    "packages/schema",
    "packages/script",
    "packages/sdk/js",
    "packages/server",
    "packages/session-ui",
    "packages/ui"
  ]
}
```

Dropped from the current glob: `packages/console/*`, `packages/stats/*`, `packages/slack`, `packages/cli`, `packages/sdk-next`, `packages/enterprise`, `packages/function`, `packages/web`, `packages/storybook`.

Root scripts to delete or stop documenting: `dev:console`, `dev:stats`, `dev:web` (the web *entry* — `packages/app` stays), `sso`.

Keep `dev:desktop`. Change default `dev` later if you want; not required for isolation.

## Size that actually matters

| Tree | Size | Kind |
|---|---|---|
| `packages/console` | ~48 MB | git weight (videos) |
| `packages/web` | ~12.5 MB | git weight |
| `packages/stats` | ~1.4 MB | git weight |
| `packages/desktop/resources/opencode-cli.exe` | ~176 MB | downloaded artifact, should stay gitignored |
| console/web/stats `node_modules` | the install pain | **killed by allowlist** |

Prune + allowlist wins both install and the GitHub tree. History still has the blobs.

## TUI decoupling (part of T5)

`packages/opencode/src/util/{record,error,locale}.ts` re-export from `@opencode-ai/tui`. Those TUI files do not import OpenTUI.

1. Inline the three files into `packages/opencode/src/util`.
2. Remove `@opencode-ai/tui` from `packages/opencode/package.json`.
3. `git rm packages/tui`. Leave `@opentui/*` on `opencode` if `src/cli/tui` still imports them — do not maintain that code; take upstream.

Re-apply the inline if an upstream tag restores the `@opencode-ai/tui` import. That is a union/prune step in the skill, not a reason to keep `packages/tui`.
