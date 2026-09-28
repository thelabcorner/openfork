import { describe, expect, test } from "bun:test"
import { relative } from "node:path"

/**
 * WakaTime integration ownership regressions.
 *
 * These are NEGATIVE tests about the current architecture: Core's
 * `wakatime.ts` is the single process-global exporter and the only
 * CodingActivity consumer; `packages/opencode/src/wakatime/` keeps exactly one
 * thin `tool.execute.after` producer; the Tier-0 transport is a bootstrap-free
 * adapter over Core; and the renderer has no persistence or secret authority.
 */

const repoRoot = new URL("../../../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

async function source(path: string): Promise<string> {
  return Bun.file(`${repoRoot}/${path}`).text()
}

async function exists(path: string): Promise<boolean> {
  return Bun.file(`${repoRoot}/${path}`).exists()
}

/** Comments may discuss a prohibition; only executable code must obey it. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

async function scanSources(relativeRoot: string): Promise<{ path: string; code: string }[]> {
  const scanned: { path: string; code: string }[] = []
  const glob = new Bun.Glob("**/*.ts")
  for await (const file of glob.scan({ cwd: `${repoRoot}/${relativeRoot}`, absolute: true })) {
    scanned.push({
      // Normalize separators: repo-relative comparisons must not depend on host.
      path: relative(repoRoot, file).replace(/\\/g, "/"),
      code: stripComments(await Bun.file(file).text()),
    })
  }
  return scanned.sort((a, b) => a.path.localeCompare(b.path))
}

const CORE_EXPORTER = "packages/core/src/wakatime.ts"
const OPENCODE_HANDLER = "packages/opencode/src/server/routes/instance/httpapi/handlers/wakatime.ts"
const OPENCODE_GROUP = "packages/opencode/src/server/routes/instance/httpapi/groups/wakatime.ts"

describe("Core owns the only WakaTime exporter", () => {
  test("the duplicate opencode exporter and its settings store are gone", async () => {
    expect(await exists(CORE_EXPORTER)).toBe(true)
    expect(await exists("packages/opencode/src/wakatime/wakatime.ts")).toBe(false)
    expect(await exists("packages/opencode/src/wakatime/settings.ts")).toBe(false)
    // The thin producer is the only thing left in the opencode lane.
    expect(await exists("packages/opencode/src/wakatime/tool-activity.ts")).toBe(true)
  })

  test("no module defines a second WakaTime service or exporter layer", async () => {
    const offenders: string[] = []
    for (const root of ["packages/core/src", "packages/opencode/src"]) {
      for (const { path, code } of await scanSources(root)) {
        if (path === CORE_EXPORTER) continue
        if (/Context\.Service<[^>]*>\("@opencode\/WakaTime"\)/.test(code)) offenders.push(path)
        if (/heartbeats\.bulk/.test(code)) offenders.push(path)
      }
    }
    expect(offenders).toEqual([])
  })

  test("Core's exporter is the single CodingActivity consumer", async () => {
    const consumers: string[] = []
    for (const root of ["packages/core/src", "packages/opencode/src"]) {
      for (const { path, code } of await scanSources(root)) {
        if (code.includes("CodingActivity.node")) consumers.push(path)
      }
    }
    expect(consumers).toEqual([CORE_EXPORTER])
  })

  test("the opencode producer stays a thin CodingActivity reporter", async () => {
    const producer = stripComments(await source("packages/opencode/src/wakatime/tool-activity.ts"))
    // It records onto the shared bus and nothing else: no transport, no
    // settings file, no credential handling, no second bus.
    expect(producer).toContain("CodingActivity.record")
    for (const forbidden of ["WakaTime", "http", "fetch", "wakatime-cli", "heartbeats", "writeFile"]) {
      expect({ forbidden, present: forbidden !== "WakaTime" && producer.includes(forbidden) }).toEqual({
        forbidden,
        present: false,
      })
    }
  })

  test("planning a tool result performs no filesystem, Git, or cwd work", async () => {
    const producer = stripComments(await source("packages/opencode/src/wakatime/tool-activity.ts"))
    // The four native V1 mutation tools (write/edit/patch/apply_patch) do not route
    // through the exchange kernel, so this adapter is the only producer for them.
    // Their result metadata is authoritative: stamping a heartbeat must stay pure
    // projection, because a realpath/stat/Git round trip per tool call would make
    // telemetry a cost on the hot path, and a cwd guess would misattribute it.
    for (const forbidden of [
      "FSUtil",
      "realpath",
      "normalizePath",
      "process.cwd",
      "statSync",
      "existsSync",
      "readFile",
      "child_process",
      "execSync",
      "Bun.",
    ]) {
      expect({ forbidden, present: producer.includes(forbidden) }).toEqual({ forbidden, present: false })
    }
    // Lexical normalization only, against the instance's own directory.
    expect(producer).toContain("path.resolve(base, value)")
    expect(producer).not.toContain("path.resolve(process")
  })

  test("Core's node is a process singleton provided in every serving graph", async () => {
    const server = stripComments(await source("packages/opencode/src/server/routes/instance/httpapi/server.ts"))
    const runtime = stripComments(await source("packages/opencode/src/effect/app-runtime.ts"))
    // Served graph: desktop/server/PWA/run/ACP/TUI-worker execution.
    expect(server).toContain("WakaTime.node")
    // Direct AppRuntime execution never builds a server graph.
    expect(runtime).toContain("WakaTime.node")
    // Both graphs must reach the same Core node, not a local reimplementation.
    expect(server).toContain('from "@opencode-ai/core/wakatime"')
    expect(runtime).toContain('from "@opencode-ai/core/wakatime"')
    // Core enforces the singleton itself, so re-registration cannot fork a
    // second subscriber.
    const exporter = stripComments(await source(CORE_EXPORTER))
    expect(exporter).toContain("canonical")
    expect(exporter).toContain("makeGlobalNode")
  })

  test("no renderer or app module constructs a WakaTime runtime", async () => {
    const offenders: string[] = []
    const glob = new Bun.Glob("**/*.{ts,tsx}")
    for await (const file of glob.scan({ cwd: `${repoRoot}/packages/app/src`, absolute: true })) {
      const code = stripComments(await Bun.file(file).text())
      if (code.includes("@opencode-ai/core/wakatime") || code.includes("WakaTime.node")) {
        offenders.push(file.replace(/\\/g, "/"))
      }
    }
    expect(offenders).toEqual([])
  })
})

describe("WakaTime transport is a bootstrap-free adapter over Core", () => {
  test("the group is declared on RootHttpApi and never on InstanceHttpApi", async () => {
    const api = await source("packages/opencode/src/server/routes/instance/httpapi/api.ts")
    const root = api.slice(api.indexOf("export const RootHttpApi"), api.indexOf("export const InstanceHttpApi"))
    const instance = api.slice(api.indexOf("export const InstanceHttpApi"), api.indexOf("export const OpenCodeHttpApi"))

    expect(root).toContain(".addHttpApi(WakaTimeApi)")
    expect(instance).not.toContain("WakaTimeApi")
  })

  test("neither the route contract nor the handler can reach an Instance or a Location", async () => {
    for (const path of [OPENCODE_GROUP, OPENCODE_HANDLER]) {
      const code = stripComments(await source(path))
      for (const forbidden of [
        "InstanceContextMiddleware",
        "WorkspaceRoutingMiddleware",
        "InstanceStore",
        "InstanceState",
        "Location.Service",
        "LocationServiceMap",
        "process.cwd(",
      ]) {
        expect({ path, forbidden, present: code.includes(forbidden) }).toEqual({ path, forbidden, present: false })
      }
    }
  })

  test("the handler imports Core directly and never provides a layer per request", async () => {
    const handler = stripComments(await source(OPENCODE_HANDLER))
    expect(handler).toContain('from "@opencode-ai/core/wakatime"')
    expect(handler).toContain("yield* WakaTime.Service")
    expect(handler).not.toContain("InstanceHttpApi")
    for (const forbidden of ["Effect.provide", "Layer.", "HttpRouter.provideRequest"]) {
      expect({ forbidden, present: handler.includes(forbidden) }).toEqual({ forbidden, present: false })
    }
  })

  test("the exposed surface is exactly status plus the enabled update", async () => {
    const group = stripComments(await source(OPENCODE_GROUP))
    const endpoints = [...group.matchAll(/HttpApiEndpoint\.\w+\("(\w+)"/g)].map((match) => match[1]).sort()
    expect(endpoints).toEqual(["status", "update"])
    // No credential mutation and no flush result projection survive on the wire.
    for (const forbidden of ["setKey", "clearKey", "ApiWakaTimeInvalidKeyError", "WakaTimeFlushResult", "flush"]) {
      expect({ forbidden, present: group.includes(forbidden) }).toEqual({ forbidden, present: false })
    }
    // A single path serves both verbs; nothing else is addressable.
    expect([...group.matchAll(/HttpApiEndpoint\.\w+\("\w+",\s*(\S+?),/g)].map((match) => match[1])).toEqual([
      "WakaTimePaths.status",
      "WakaTimePaths.status",
    ])
  })

  test("the status projection matches Core's Status and carries no secret", async () => {
    const group = stripComments(await source(OPENCODE_GROUP))
    const status = group.slice(group.indexOf("export const WakaTimeStatus"), group.indexOf("export const WakaTimeUpdatePayload"))
    expect(status).toContain("enabled: Schema.Boolean")
    expect(status).toContain("configured: Schema.Boolean")
    expect(status).toContain("cli: Schema.optional(Schema.String)")
    expect(status).toContain('source: Schema.optional(Schema.Literals(["override", "system", "managed"]))')
    // Queue depth / last-send telemetry are not Core facts, so they must not
    // reappear as invented transport fields.
    for (const forbidden of ["queued", "lastSent", "lastError", "key", "apiKey", "secret", "token"]) {
      expect({ forbidden, present: new RegExp(`\\b${forbidden}\\s*:`).test(status) }).toEqual({
        forbidden,
        present: false,
      })
    }
  })
})

describe("the renderer has no WakaTime persistence or secret authority", () => {
  test("the settings surface offers no API-key input and stores nothing locally", async () => {
    const files = [
      "packages/app/src/components/settings-v2/wakatime.tsx",
      "packages/app/src/components/settings-v2/wakatime-model.ts",
      "packages/app/src/i18n/en-settings-wakatime.ts",
      "packages/app/src/components/settings-v2/settings-wakatime.css",
    ]
    for (const path of files) {
      const code = stripComments(await source(path))
      for (const forbidden of [
        "setKey",
        "clearKey",
        "localStorage",
        "sessionStorage",
        "TextInputV2",
        "type=\"password\"",
        "wakatime.flush",
      ]) {
        expect({ path, forbidden, present: code.includes(forbidden) }).toEqual({ path, forbidden, present: false })
      }
    }
  })

  test("the panel reads status and forwards only the opt-in intent", async () => {
    const panel = stripComments(await source("packages/app/src/components/settings-v2/wakatime.tsx"))
    expect(panel).toContain("client().wakatime.status(")
    expect(panel).toContain("client().wakatime.update(")
    // One writable fact: the opt-in toggle.
    expect([...panel.matchAll(/client\(\)\.wakatime\.(\w+)\(/g)].map((match) => match[1])).toEqual([
      "status",
      "update",
    ])
  })
})

const OPENCODE_SESSION_FLUSH = "packages/opencode/src/wakatime/session-flush.ts"

describe("session settlement is one process-global Idle consumer over Core", () => {
  test("the adapter is a global node registered in both runtime graphs", async () => {
    const adapter = stripComments(await source(OPENCODE_SESSION_FLUSH))
    const server = stripComments(await source("packages/opencode/src/server/routes/instance/httpapi/server.ts"))
    const runtime = stripComments(await source("packages/opencode/src/effect/app-runtime.ts"))
    // Direct AppRuntime execution and the served httpapi graph are compiled
    // independently, so an adapter present in only one of them would leave the
    // other with settled sessions it never reports. Registering it in both is
    // safe because both build it through the shared process-wide memoMap.
    expect(runtime).toContain("WakaTimeSessionFlush.node")
    expect(server).toContain("WakaTimeSessionFlush.node")
    // A global node over the two process-global boundaries, and nothing else.
    expect(adapter).toContain("makeGlobalNode")
    expect(adapter).toContain("EventV2.node")
    expect(adapter).toContain("WakaTime.node")
    // Exactly one subscription, on the one canonical terminal event. Busy,
    // retry, and status transitions are not settlement.
    expect([...adapter.matchAll(/listenType\(\s*(\S+?),/g)].map((match) => match[1])).toEqual([
      "SessionStatusEvent.Idle",
    ])
    // The subscription is scope-bound, not detached.
    expect(adapter).toContain("Effect.acquireRelease")
  })

  test("settlement requests only; it never delivers, records, or forks", async () => {
    const adapter = stripComments(await source(OPENCODE_SESSION_FLUSH))
    // EventV2 runs listenType callbacks inline on the publish path, so the
    // callback must reach only for Core's O(1) scheduler request and never for
    // anything that could do CLI, network, or filesystem work inline.
    expect(adapter).toContain("requestFlushSession")
    for (const forbidden of ["flushSession(", ".flush(", ".record(", "CodingActivity", "wakatime-cli", "heartbeats"]) {
      expect({ forbidden, present: adapter.includes(forbidden) }).toEqual({ forbidden, present: false })
    }
    // No per-session fiber, timer, queue, or state: N concurrent sessions must
    // still cost exactly one callback.
    for (const forbidden of ["forkScoped", "forkIn", "forkDetach", "setInterval", "setTimeout", "Queue.", "PubSub."]) {
      expect({ forbidden, present: adapter.includes(forbidden) }).toEqual({ forbidden, present: false })
    }
  })

  test("the adapter holds no Location/Instance ownership and no renderer state", async () => {
    const adapter = stripComments(await source(OPENCODE_SESSION_FLUSH))
    for (const forbidden of [
      "InstanceContextMiddleware",
      "InstanceStore",
      "InstanceState",
      "InstanceRef",
      "Location.Service",
      "LocationServiceMap",
      "process.cwd(",
      "localStorage",
      "sessionStorage",
    ]) {
      expect({ forbidden, present: adapter.includes(forbidden) }).toEqual({ forbidden, present: false })
    }
    // Idle already names the session it settles, so there is nothing to look up.
    for (const forbidden of ["Message", "Part", "history", "Session.Service", "SessionStatus.Service"]) {
      expect({ forbidden, present: adapter.includes(forbidden) }).toEqual({ forbidden, present: false })
    }
  })
})
