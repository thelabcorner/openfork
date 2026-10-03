import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { deflateRawSync } from "node:zlib"
import { resolveWakaTimeHome, WakaTime } from "@opencode-ai/core/wakatime"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect } from "effect"

/**
 * `WakaTime.node` is a process singleton by design, so its service-level
 * behavior is exercised in a child process (see fixture/wakatime-process.fixture.ts)
 * where the module-global state is naturally fresh. This file covers the pure
 * projection/archive logic plus the ownership invariants, and delegates the
 * service scenarios to isolated child processes.
 */

const fixture = new URL("./fixture/wakatime-process.fixture.ts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Comments may discuss a prohibition; only executable code must obey it. */
function stripComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
}

async function source() {
  return stripComments(await Bun.file(new URL("../src/wakatime.ts", import.meta.url)).text())
}

/** The executable body between two unique anchors, exclusive of both. */
function section(text: string, startAnchor: string, endAnchor: string) {
  const start = text.indexOf(startAnchor)
  const end = text.indexOf(endAnchor, start + startAnchor.length)
  assert(start !== -1 && end > start, `WakaTime must contain the section between ${startAnchor} and ${endAnchor}`)
  return text.slice(start, end)
}

const scenarios = [
  "opt-in-default-off",
  "opt-in-explicit",
  "unconfigured",
  "status-no-download",
  "batching",
  "coalesce-merge",
  "signed-deltas",
  "project-folder",
  "replay-dedupe",
  "principal-source-ref-not-replay-token",
  "replay-evicted-recovers",
  "replay-coalesced-recovers",
  "flush-session",
  "flush-session-clears-urgency-marker",
  "request-flush-session",
  "request-flush-unrelated-session",
  "flush-clears-urgency-markers",
  "request-flush-duplicate-session",
  "pending-session-index-accounting",
  "request-many-sessions-one-scheduler",
  "queue-not-held-during-delivery",
  "automatic-project-fairness",
  "same-key-reenqueue-inflight",
  "permit-wait-interruption-releases-replay",
  "cli-attempt-failure-semantics",
  "single-scheduler-burst",
  "delivery-limiter",
  "delivery-limiter-restart-state",
  "project-window-bound",
  "cross-project-batch",
  "source-attribution-batch",
  "source-attribution-limiter",
  "managed-http-byte-bounds",
  "managed-cli-stays-offline",
  "managed-cli-freshness",
  "managed-cli-update-failure",
  "enable-prepares-managed-cli",
  "env-disable-skips-cli-prepare",
  "enable-reuses-override-cli",
  "enable-reuses-system-cli",
  "enable-reuses-managed-cli",
  "unauthenticated-no-delivery",
  "coding-activity-single-consumer",
  "set-enabled",
  "opt-out-clears-transient-state",
  "opt-out-env-precedence",
  "singleton",
  "concurrent-singleton",
  "graph-close-reuse",
  "last-lease-finalizes",
] as const

async function runScenario(name: (typeof scenarios)[number]) {
  // Isolate the persisted opt-in and the managed-CLI cache root: the child
  // resolves both from XDG dirs at module init, so they must be redirected
  // before it starts or resolution could find the host's real installs.
  const state = await mkdtemp(path.join(os.tmpdir(), "openfork-wakatime-state-"))
  const cache = await mkdtemp(path.join(os.tmpdir(), "openfork-wakatime-cache-"))
  const child = Bun.spawn([process.execPath, fixture, name], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, XDG_STATE_HOME: state, XDG_CACHE_HOME: cache },
  })
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`scenario ${name} failed (exit ${exitCode})\n${stdout}\n${stderr}`)
    return stdout
  } finally {
    await Promise.all([
      rm(state, { recursive: true, force: true }),
      rm(cache, { recursive: true, force: true }),
    ])
  }
}

describe("WakaTime process-global exporter", () => {
  test("resolves WAKATIME_HOME with official tilde semantics", () => {
    const home = path.join("root", "operator")
    expect(resolveWakaTimeHome(undefined, home)).toBe(home)
    expect(resolveWakaTimeHome("", home)).toBe(home)
    expect(resolveWakaTimeHome("~", home)).toBe(home)
    expect(resolveWakaTimeHome("~/wakatime", home)).toBe(path.join(home, "wakatime"))
    expect(resolveWakaTimeHome("~\\wakatime", home)).toBe(path.join(home, "wakatime"))
    expect(resolveWakaTimeHome("  /explicit/wakatime  ", home)).toBe("/explicit/wakatime")
  })

  for (const name of scenarios) {
    // A scenario drives real coalescing windows and, for the managed-CLI cases,
    // real persistence and atomic replacement, so the default 5s cap is too
    // tight for the delivery-limiter proof in particular.
    test(`scenario: ${name}`, async () => {
      const stdout = await runScenario(name)
      expect(stdout).toContain("WAKATIME_FIXTURE_RESULT ")
    }, 30_000)
  }

  test("every scenario is implemented in the fixture", async () => {
    const child = Bun.spawn([process.execPath, fixture], { stdout: "pipe", stderr: "pipe" })
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited).toBe(2)
    for (const name of scenarios) expect(stderr).toContain(name)
  })
})

describe("WakaTime ownership invariants", () => {
  test("the CodingActivity bus is subscribed exactly once in the module", async () => {
    const text = await source()
    expect(text.match(/coding\.stream\(\)/g) ?? []).toHaveLength(1)
  })

  test("no exporter fiber is bound to a graph scope", async () => {
    const text = await source()
    // A graph scope would interrupt the CodingActivity consumer and the debounce
    // timer the first time that graph closed, stranding every later graph.
    expect(text).not.toContain("Scope.Scope")
    const forks = text.match(/Effect\.forkIn\([^,)]+/g) ?? []
    expect(forks).toHaveLength(2)
    for (const fork of forks) expect(fork).toContain("processScope")
  })

  test("the runtime is leased and finalized instead of leaking", async () => {
    const text = await source()
    expect(text).toContain("canonical = undefined")
    expect(text).toContain("Scope.close(processScope")
    expect(text).toContain("Effect.addFinalizer(() => release(runtime))")
  })

  test("production exposes no test-only process singleton reset", async () => {
    expect(await source()).not.toContain("resetProcessRuntime")
  })

  test("the status path cannot reach the downloader", async () => {
    const text = await source()
    const statusBody = section(text, 'const status: Interface["status"]', "const service: Interface")
    expect(statusBody).toContain("probeBinary")
    expect(statusBody).not.toContain("resolveBinary")
    expect(statusBody).not.toContain("installManaged")
  })

  test("WakaTime stays a Tier-0 global service with no location or instance dependency", async () => {
    const text = await source()
    for (const forbidden of ["Location.Service", "LocationServiceMap", "InstanceState", "InstanceStore", "process.cwd("]) {
      expect(text).not.toContain(forbidden)
    }
  })

  test("Core owns the only WakaTime opt-in authority", async () => {
    const text = await source()
    expect(text).toContain("setEnabled")
    expect(text).toContain("settingsFile()")
    // Enablement authority must not survive in the V1 settings runtime.
    expect(
      await Bun.file(new URL("../../opencode/src/wakatime/settings.ts", import.meta.url)).exists(),
    ).toBe(false)
  })

  test("the persisted opt-in carries no credential material", async () => {
    const text = await source()
    const parsed = section(text, "export function parseSettings", "function configHome()")
    expect(parsed).toContain('typeof enabled === "boolean"')
    for (const forbidden of ["apiKey", "token", "secret"]) {
      expect(parsed).not.toContain(forbidden)
    }
  })

  test("the exporter keeps owning its own AI transcript production", async () => {
    const text = await source()
    // The official CLI scans AI transcript stores on its own; OpenFork owns its
    // own activity producer and must never ingest another editor's transcripts.
    expect(text).toContain('"--sync-ai-disabled"')
  })
})

describe("WakaTime persisted opt-in", () => {
  test("defaults to disabled and lives in the global state directory", () => {
    expect(WakaTime.DEFAULT_SETTINGS).toEqual({ enabled: false })
    expect(path.basename(WakaTime.settingsFile())).toBe("wakatime.json")
    expect(path.dirname(WakaTime.settingsFile())).toContain("openfork")
  })

  test("treats anything but a boolean enabled flag as disabled", () => {
    expect(WakaTime.parseSettings(undefined)).toEqual({ enabled: false })
    expect(WakaTime.parseSettings(null)).toEqual({ enabled: false })
    expect(WakaTime.parseSettings("{not json")).toEqual({ enabled: false })
    expect(WakaTime.parseSettings({ enabled: "yes" })).toEqual({ enabled: false })
    expect(WakaTime.parseSettings({ enabled: true })).toEqual({ enabled: true })
    expect(WakaTime.parseSettings({ enabled: false })).toEqual({ enabled: false })
    // Unknown and secret-shaped fields are dropped rather than propagated.
    expect(WakaTime.parseSettings({ enabled: true, apiKey: "secret" })).toEqual({ enabled: true })
  })
})

describe("WakaTime activity projection", () => {
  test("carries the observed project folder plus the internal routing metadata", () => {
    const projected = WakaTime.fromCodingActivity({
      entity: "/repo/a.ts",
      kind: "write",
      time: 1_700_000_000,
      aiLineChanges: -5,
      project: "openfork",
      projectFolder: "/repo",
      aiSession: "ses_alpha",
      source: "session",
      sourceRef: "call_01",
      replayToken: "event_01",
    })

    expect(projected).toEqual({
      entity: "/repo/a.ts",
      entityType: "file",
      category: "ai coding",
      isWrite: true,
      // A signed net reaches the projection untouched.
      aiLineChanges: -5,
      projectFolder: "/repo",
      aiSession: "ses_alpha",
      source: "session",
      sourceRef: "call_01",
      replayToken: "event_01",
      kind: "write",
      // The observation's own moment, not the projection time.
      time: 1_700_000_000_000,
    })
  })

  test("never invents a project folder the producer did not observe", () => {
    const projected = WakaTime.fromCodingActivity({
      entity: "/repo/a.ts",
      kind: "read",
      time: 1_700_000_000,
      project: "openfork",
      source: "session",
    })
    // Naming a project is not proving a directory, so the key is absent
    // entirely rather than derived from the display name or a working directory.
    expect(projected).not.toHaveProperty("projectFolder")
    expect(projected.projectFolder).toBeUndefined()
    expect(WakaTime.neutralCwd(path.join(path.parse(process.cwd()).root, "users", "operator"))).toBe(
      path.parse(process.cwd()).root,
    )
  })

  test("coalescing keeps write state sticky and merges signed deltas arithmetically", () => {
    const merged = WakaTime.mergeActivities(
      { entity: "/repo/a.ts", aiLineChanges: 3, isWrite: true, time: 10 },
      { entity: "/repo/a.ts", aiLineChanges: 4, time: 20 },
    )
    expect(merged.aiLineChanges).toBe(7)
    expect(merged.isWrite).toBe(true)
    expect(merged.time).toBe(20)

    expect(WakaTime.mergeActivities(undefined, { entity: "/repo/a.ts" }).aiLineChanges).toBeUndefined()
  })

  test("a negative net delta survives coalescing instead of being clamped to zero", () => {
    expect(
      WakaTime.mergeActivities(
        { entity: "/repo/a.ts", aiLineChanges: -3, time: 10 },
        { entity: "/repo/a.ts", aiLineChanges: -4, time: 20 },
      ).aiLineChanges,
    ).toBe(-7)
    // Deletion-dominant work: additions minus deletions is still negative.
    expect(
      WakaTime.mergeActivities(
        { entity: "/repo/a.ts", aiLineChanges: 5, time: 10 },
        { entity: "/repo/a.ts", aiLineChanges: -9, time: 20 },
      ).aiLineChanges,
    ).toBe(-4)
  })

  test("the transport has no nonnegative clamp on a line-change delta", async () => {
    const text = await source()
    // The only gate on a reported delta is whether there is one to report.
    expect(text).toContain("reportableLineChanges")
    const merge = section(text, "export function mergeActivities", "export function fromCodingActivity")
    expect(merge).toContain("(previous.aiLineChanges ?? 0) + (next.aiLineChanges ?? 0)")
    expect(merge).not.toMatch(/Math\.max\(0,\s*(previous|next|activity)\.aiLineChanges/)
    for (const body of [
      section(text, "function extraHeartbeat", "function heartbeatArgs"),
      section(text, "function heartbeatArgs", "interface ProcessRuntime"),
    ]) {
      expect(body).not.toMatch(/Math\.max\(0,\s*(activity|lineChanges)/)
    }
  })
})

describe("WakaTime plugin identity", () => {
  test("separates OpenFork, OXP, and OFXP behind one stable integration token", () => {
    expect(WakaTime.pluginIdentifier()).toBe(
      `openfork/${InstallationVersion} openfork-wakatime/${InstallationVersion}`,
    )
    expect(WakaTime.pluginIdentifier("openfork-oxp")).toBe(
      `openfork-oxp/${InstallationVersion} openfork-wakatime/${InstallationVersion}`,
    )
    expect(WakaTime.pluginIdentifier("openfork-ofxp")).toBe(
      `openfork-ofxp/${InstallationVersion} openfork-wakatime/${InstallationVersion}`,
    )
    expect(WakaTime.attribution({ source: "oxp" })).toBe("openfork-oxp")
    expect(WakaTime.attribution({ source: "ofxp" })).toBe("openfork-ofxp")
    expect(WakaTime.attribution({ source: "session" })).toBe("openfork")
    expect(WakaTime.attribution({ source: "special-agent" })).toBe("openfork")
    expect(WakaTime.attribution({})).toBe("openfork")
  })

  test("carrier client changes cannot fragment source attribution", () => {
    const previous = process.env.OPENCODE_CLIENT
    try {
      process.env.OPENCODE_CLIENT = "acp"
      expect(WakaTime.pluginIdentifier()).toBe(
        `openfork/${InstallationVersion} openfork-wakatime/${InstallationVersion}`,
      )
      expect(WakaTime.pluginIdentifier("openfork-oxp")).toBe(
        `openfork-oxp/${InstallationVersion} openfork-wakatime/${InstallationVersion}`,
      )
      delete process.env.OPENCODE_CLIENT
      expect(WakaTime.pluginIdentifier()).toBe(
        `openfork/${InstallationVersion} openfork-wakatime/${InstallationVersion}`,
      )
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_CLIENT
      else process.env.OPENCODE_CLIENT = previous
    }
  })

  test("delivery grouping separates attribution without splitting the project limiter", () => {
    const base: WakaTime.Activity = { entity: "/repo/a.ts", projectFolder: "/repo" }
    const native = { ...base, source: "session" as const }
    const oxp = { ...base, source: "oxp" as const }
    const ofxp = { ...base, source: "ofxp" as const }
    expect(WakaTime.projectKey(native)).toBe(WakaTime.projectKey(oxp))
    expect(WakaTime.projectKey(oxp)).toBe(WakaTime.projectKey(ofxp))
    expect(WakaTime.deliveryGroupKey(native)).not.toBe(WakaTime.deliveryGroupKey(oxp))
    expect(WakaTime.deliveryGroupKey(oxp)).not.toBe(WakaTime.deliveryGroupKey(ofxp))
  })
})

describe("WakaTime replay and project identity", () => {
  const base: WakaTime.Activity = {
    entity: "/repo/a.ts",
    source: "session",
    aiSession: "ses_a",
    sourceRef: "actor_alpha",
    replayToken: "call_01",
    kind: "write",
  }

  test("only a producer-proven replay token makes a record eligible for replay suppression", () => {
    expect(WakaTime.replayKey(base)).toBeTruthy()
    // Actor identity is deliberately insufficient: one principal can perform
    // many legitimate observations on the same file.
    expect(WakaTime.replayKey({ ...base, replayToken: undefined })).toBeUndefined()
    expect(WakaTime.replayKey({ ...base, replayToken: "   " })).toBeUndefined()
    expect(
      WakaTime.replayKey({ entity: "/repo/a.ts", source: "ofxp", sourceRef: "ofxp:peer:principal", kind: "write" }),
    ).toBeUndefined()
    // Without a token there is no proof two records are the same event, and
    // dropping a legitimate repeat would lose real coding time.
    expect(WakaTime.replayKey({ entity: "/repo/a.ts", source: "session", kind: "write" })).toBeUndefined()
  })

  test("the replay identity separates producer, session, entity, and kind", () => {
    const key = WakaTime.replayKey(base)!
    expect(WakaTime.replayKey({ ...base })).toBe(key)
    expect(WakaTime.replayKey({ ...base, source: "core" })).not.toBe(key)
    expect(WakaTime.replayKey({ ...base, aiSession: "ses_b" })).not.toBe(key)
    expect(WakaTime.replayKey({ ...base, entity: "/repo/b.ts" })).not.toBe(key)
    expect(WakaTime.replayKey({ ...base, kind: "read" })).not.toBe(key)
    expect(WakaTime.replayKey({ ...base, sourceRef: "actor_beta" })).toBe(key)
    expect(WakaTime.replayKey({ ...base, replayToken: "call_02" })).not.toBe(key)
  })

  test("falls back to the write flag when no kind was recorded", () => {
    expect(WakaTime.replayKey({ entity: "/repo/a.ts", replayToken: "call_01", isWrite: true })).toBe(
      WakaTime.replayKey({ entity: "/repo/a.ts", replayToken: "call_01", kind: "write" }),
    )
    expect(WakaTime.replayKey({ entity: "/repo/a.ts", replayToken: "call_01" })).toBe(
      WakaTime.replayKey({ entity: "/repo/a.ts", replayToken: "call_01", kind: "read" }),
    )
  })

  test("keys the delivery limiter by the proven folder with one deterministic fallback", () => {
    expect(WakaTime.projectKey({ entity: "/repo/a.ts", projectFolder: "/repo" })).toBe("/repo")
    expect(WakaTime.projectKey({ entity: "/repo/a.ts", projectFolder: "  " })).toBe(WakaTime.NO_PROJECT_KEY)
    // No proven folder means no finer project identity, so every such record
    // shares one limiter bucket rather than being spread across invented ones.
    expect(WakaTime.projectKey({ entity: "/repo/a.ts" })).toBe(WakaTime.NO_PROJECT_KEY)
    expect(WakaTime.projectKey({ entity: "/other/b.ts" })).toBe(WakaTime.projectKey({ entity: "/repo/a.ts" }))
    expect(WakaTime.projectKey({ entity: "/repo/a.ts", projectFolder: "/repo" })).not.toBe(
      WakaTime.projectKey({ entity: "/other/b.ts", projectFolder: "/other" }),
    )
  })

  test("persists only bounded hashed project delivery windows", () => {
    const now = 1_000_000
    const alpha = WakaTime.deliveryWindowKey("/alpha/private/project")
    const beta = WakaTime.deliveryWindowKey("/beta/private/project")
    expect(alpha).toMatch(/^[0-9a-f]{64}$/)
    expect(beta).toMatch(/^[0-9a-f]{64}$/)
    expect(alpha).not.toBe(beta)
    expect(alpha).not.toContain("alpha")

    const parsed = WakaTime.parseDeliveryState(
      {
        version: 1,
        windows: [
          { key: alpha, at: now - 1_000 },
          { key: alpha, at: now - 500 },
          { key: beta, at: now + 50_000 },
          { key: WakaTime.deliveryWindowKey("/stale"), at: now - WakaTime.MIN_DELIVERY_INTERVAL_MS },
          { key: "/raw/project/path", at: now - 100 },
          { key: "not-a-hash", at: now - 100 },
          { key: WakaTime.deliveryWindowKey("/invalid-time"), at: Number.NaN },
        ],
      },
      now,
    )
    expect(parsed).toEqual([
      { key: alpha, at: now - 500 },
      { key: beta, at: now },
    ])
    expect(JSON.stringify(parsed)).not.toContain("/alpha/private/project")
    expect(WakaTime.normalizeDeliveryWindows([{ key: alpha, at: now }], now, 60_000, 0)).toEqual([])
  })
})

describe("WakaTime delivery limiting and session-selective flush", () => {
  test("a held record is branched away from, never removed from the queue", async () => {
    const body = section(await source(), "const takeEligible = Effect.sync(() => {", "const takeForSession")
    // The hold branch must be evaluated before anything is taken, otherwise a
    // throttled project would be dropped instead of delayed.
    expect(body).toContain("if (remaining > 0)")
    expect(body).toContain("heldUntil = heldUntil === 0 ? remaining : Math.min(heldUntil, remaining)")
    expect(body.indexOf("Math.min(heldUntil, remaining)")).toBeLessThan(body.indexOf("takePending(key)"))
    expect(body).toContain("ready.push(taken)")
    expect(body).not.toContain("dropPending(key, true)")
  })

  test("automatic delivery yields after one project while keeping its attribution siblings together", async () => {
    expect(WakaTime.MAX_AUTOMATIC_PROJECTS_PER_RUN).toBe(1)
    const text = await source()
    const take = section(text, "const takeEligible = Effect.sync(() => {", "const takeForSession")
    expect(take).toContain("const selectedProjects = new Set<string>()")
    expect(take).toContain("selectedProjects.size >= MAX_AUTOMATIC_PROJECTS_PER_RUN")
    expect(take).toContain("moreReady = true")
    // A project already selected remains eligible after the cap is reached, so
    // OpenFork/OXP/OFXP groups for that project stay in the same delivery turn.
    expect(take.indexOf("!selectedProjects.has(project)")).toBeLessThan(take.indexOf("selectedProjects.add(project)"))

    const scheduler = section(text, "armLocked = Effect.fnUntraced", "const arm = (delayMs = DEBOUNCE_MS)")
    expect(scheduler).toContain("const requestedWake = taken.moreReady ? 0 : wake")
  })

  test("a held window is rescheduled instead of retried or discarded", async () => {
    const text = await source()
    expect(text).toContain("MIN_DELIVERY_INTERVAL_MS")
    expect(text).toContain("decideNextDelay(requestedWake, taken.heldUntil)")
    expect(text).toContain("const arm = (delayMs = DEBOUNCE_MS)")
  })

  test("both explicit flushes bypass the limiter", async () => {
    const text = await source()
    const flush = section(text, 'const flush: Interface["flush"]', 'const flushSession: Interface["flushSession"]')
    const session = section(text, 'const flushSession: Interface["flushSession"]', 'const clearTransientState')
    // Neither forced path consults the delivery window: the caller asked, so the
    // request is honoured. Once prerequisites admit a real CLI attempt, both
    // still stamp it through the common delivery path.
    expect(flush).not.toContain("lastDelivery")
    expect(session).not.toContain("lastDelivery")
    expect(session).toContain("takeForSession(sessionID)")
    expect(text).toContain("const deliver = Effect.fnUntraced")
  })

  test("a session flush leaves the shared coalescing window armed", async () => {
    const session = section(await source(), 'const flushSession: Interface["flushSession"]', 'const clearTransientState')
    // Cancelling the shared window would strand every other session's queued
    // work with nothing left to fire it.
    expect(session).not.toContain("cancelTimer")
  })

  test("replay suppression is bounded and deterministic", async () => {
    const body = section(await source(), 'const record: Interface["record"]', 'const flush: Interface["flush"]')
    expect(body).toContain("replayKey(activity)")
    expect(body).toContain("if (seen.has(fingerprint)) continue")
    expect(body).toContain("seen.size > REPLAY_DEDUPE_BOUND")
    // Insertion-ordered eviction: the oldest fingerprint leaves first.
    expect(body).toContain("seen.values().next().value")
    // A fully replayed batch must not restart the window.
    expect(body).toContain("if (accepted > 0) yield* arm()")
  })

  test("a delivery batch is partitioned by project and attribution without splitting the limiter", async () => {
    const body = section(await source(), "const deliver = Effect.fnUntraced", "const cancelTimer")
    expect(body).toContain("deliveryGroupKey(activity)")
    expect(body).toContain("project: projectKey(activity)")
    expect(body).toContain("const openedProjects = new Set<string>()")
    expect(body).toContain("if (!openedProjects.has(group.project))")
    expect(body).toContain("openWindow(group.project)")
    expect(body).toContain("send(binary, group.items.map((item) => item.activity))")
    // Replay state becomes durable only once prerequisites admit a real attempt.
    expect(body.indexOf("prepareDelivery()")).toBeLessThan(body.indexOf("settle(group.items, true)"))
    expect(body.indexOf("settle(group.items, true)")).toBeLessThan(body.indexOf("openWindow(group.project)"))
    // A single spawn for a mixed batch would either file one project's time
    // under another root or apply one attribution identity to another source.
    expect(body).not.toMatch(/send\(batch\)/)
    // Strictly sequential: no unbounded fan-out of concurrent CLI processes.
    expect(body).not.toContain("Effect.forEach")
    expect(body).not.toContain("concurrency")
  })

  test("the queue mutex is never held across wakatime-cli work", async () => {
    const text = await source()
    // Every forced path snapshots under the lock and delivers outside it. A spawn
    // can take up to SENTINEL_TIMEOUT, and holding the scarce queue semaphore
    // for that long would stall every producer's enqueue behind one slow CLI.
    for (const [start, end, delivers] of [
      ['const flush: Interface["flush"]', 'const requestFlushSession: Interface["requestFlushSession"]', true],
      // The request path never delivers at all — that is the whole point of it.
      ['const requestFlushSession: Interface["requestFlushSession"]', 'const flushSession: Interface["flushSession"]', false],
      ['const flushSession: Interface["flushSession"]', "const clearTransientState", true],
    ] as const) {
      const body = section(text, start, end)
      assert(body.includes("mutex.withPermit"), `${start} must take its batch under the queue lock`)
      if (delivers) {
        assert(body.indexOf("deliver(") !== -1, `${start} must deliver the batch it took`)
        assert(
          body.indexOf("mutex.withPermit") < body.indexOf("deliver("),
          `${start} must release the queue lock before delivering`,
        )
      }
    }
    // `send` — the only place a process is spawned — is reachable only through
    // `deliver`, which is always called outside the queue lock.
    const send = section(text, "const send = Effect.fn", "const pruneWindows")
    expect(send).not.toContain("mutex.withPermit")
    // Teardown follows the same rule.
    const finalize = section(text, "finalize: Effect.gen", "satisfies ProcessRuntime")
    expect(finalize.indexOf("mutex.withPermit")).toBeLessThan(finalize.indexOf("deliver(batch)"))
    expect(finalize).toContain("Effect.timeout(SHUTDOWN_FLUSH_TIMEOUT)")
  })
})

describe("WakaTime bounded background state", () => {
  test("every accumulated structure is hard-capped", async () => {
    const text = await source()
    expect(WakaTime.DELIVERY_PROJECT_BOUND).toBe(512)
    expect(WakaTime.URGENT_SESSION_BOUND).toBeLessThanOrEqual(512)
    expect(WakaTime.REPLAY_DEDUPE_BOUND).toBeGreaterThan(0)
    // Each structure is guarded by a deterministic bound where it is actually
    // enforced, not merely declared.
    expect(section(text, 'const record: Interface["record"]', 'const flush: Interface["flush"]')).toContain(
      "REPLAY_DEDUPE_BOUND",
    )
    expect(
      section(
        text,
        'const requestFlushSession: Interface["requestFlushSession"]',
        'const flushSession: Interface["flushSession"]',
      ),
    ).toContain("URGENT_SESSION_BOUND")
    expect(
      section(text, "const pruneWindows = (now: number) => {", "const openWindow"),
    ).toContain("DELIVERY_PROJECT_BOUND")
    // The queue itself stays bounded by its own existing cap.
    expect(text).toContain("MAX_PENDING")
  })

  test("prunes by LRU head and evicts past the cap", async () => {
    const body = section(await source(), "const pruneWindows = (now: number) => {", "const openWindow")
    // An entry at least one limiter window old is indistinguishable from a
    // missing one, so pruning it changes no decision — and it must be reclaimed
    // even while the map is still below the cap.
    expect(body).not.toContain("if (lastDelivery.size <= DELIVERY_PROJECT_BOUND) return")
    expect(body).toContain("< MIN_DELIVERY_INTERVAL_MS) break")
    expect(body).toContain("while (lastDelivery.size > DELIVERY_PROJECT_BOUND)")
    // Oldest-first, and only the head is inspected, so the walk is amortized O(1)
    // rather than a full-map scan on every stamp.
    expect(body).toContain("lastDelivery.keys().next().value")
    expect(body).not.toMatch(/for \(const \[.*\] of lastDelivery\)/)
    // Pruned before the limiter is read, not only on the write path.
    const take = section(await source(), "const takeEligible = Effect.sync(() => {", "const takeForSession")
    expect(take).toContain("pruneWindows(now)")
    // The cap is enforced AFTER insertion, so the bound is a true hard cap and
    // the map never transiently exceeds it.
    const open = section(await source(), "const openWindow = (scope: string) => {", "const deliver")
    expect(open).toContain("lastDelivery.set(key, at)")
    expect(open.indexOf("lastDelivery.set(key, at)")).toBeLessThan(open.indexOf("pruneWindows(at)"))
  })

  test("admission is pure process memory and delivery caches the config probe", async () => {
    const text = await source()
    const record = section(text, 'const record: Interface["record"]', 'const flush: Interface["flush"]')
    // The producer hot path runs once per coding observation. It must not stat
    // ~/.wakatime.cfg, resolve a binary, or touch the network.
    for (const forbidden of [
      "deliverable",
      "configured",
      "configuredCached",
      "isFile",
      "resolveBinary",
      "probeBinary",
      "fetch",
      "app.run",
      "realPath",
      "realpath",
      "FSUtil",
      "path.resolve",
      "path.normalize",
    ]) {
      expect(record).not.toContain(forbidden)
    }
    expect(record).toContain("if (!optedIn()) return")
    // Delivery consults credentials once per attempt, through a short TTL cache,
    // so a burst of coalescing windows costs no filesystem work.
    expect(text).toContain("const configuredCached = () => {")
    expect(text).toContain("CONFIG_PROBE_TTL_MS")
    expect(section(text, "const prepareDelivery = Effect.fn", "const send = Effect.fn")).toContain("deliverableCached()")
    expect(section(text, "const send = Effect.fn", "const pruneWindows")).not.toContain("deliverableCached()")
    // A user-invoked status deliberately bypasses the cache.
    const status = section(text, 'const status: Interface["status"]', "const service: Interface")
    expect(status).toContain("configured()")
    expect(status).not.toContain("configuredCached")
  })

  test("a window that already took its batch is never interrupted", async () => {
    const text = await source()
    // Its work is out of the queue, so a later arm() may replace the window but
    // must not abandon it: interrupting there would silently drop queued time.
    const cancel = section(text, "const cancelTimer = Effect.fnUntraced", "let armLocked!")
    expect(cancel).toContain("if (current && !delivering) yield* Fiber.interrupt(current)")
    const arm = section(text, "let armLocked!", 'const record: Interface["record"]')
    expect(arm).toContain("if (slice.ready.length > 0) delivering = true")
    // The flag is raised under the same lock that removed the slice, and lowered
    // on every exit from the delivery.
    expect(arm).toContain("Effect.ensuring(Effect.sync(() => (delivering = false)))")
  })

  test("exactly one delivery pipeline is in flight at a time", async () => {
    const text = await source()
    // A dedicated delivery permit, never the queue lock: producers stay free to
    // enqueue while a CLI process runs, yet spawns stay sequential.
    expect(text).toContain("const delivery = Semaphore.makeUnsafe(1)")
    const deliver = section(text, "const deliver = Effect.fnUntraced", "const cancelTimer")
    expect(deliver).toContain("delivery.withPermit")
    expect(deliver).not.toContain("mutex.withPermit")
  })
})

describe("WakaTime nonblocking session flush lifecycle", () => {
  test("a request does only bounded in-memory work under the lock", async () => {
    const body = section(
      await source(),
      'const requestFlushSession: Interface["requestFlushSession"]',
      'const flushSession: Interface["flushSession"]',
    )
    // The host Idle adapter must never block on, or trigger, real work.
    for (const forbidden of [
      "resolveBinary",
      "refreshManaged",
      "installManaged",
      "fetchText",
      "app.run",
      "readFileStringSafe",
      "loadManagedState",
      "deliver(",
      "send(",
    ]) {
      expect(body).not.toContain(forbidden)
    }
    // It re-arms the ONE existing scheduler rather than adding a timer, and does
    // so in the same queue-mutex critical section that records the marker, so a
    // marker can never land against a window the scheduler already read past.
    expect(body).toContain("mutex.withPermit")
    expect(body).toContain("urgent.add(session)")
    expect(body).toContain("armLocked(0)")
    // `arm` would re-acquire the permit already held; the locked variant is used
    // instead so the permit is taken exactly once.
    expect(body).not.toMatch(/yield\* arm\(0\)/)
    expect(body).toContain("while (urgent.size > URGENT_SESSION_BOUND)")
    expect(body).toContain("urgent.values().next().value")
  })

  test("a request for a session with nothing queued returns before any mutation", async () => {
    const body = section(
      await source(),
      'const requestFlushSession: Interface["requestFlushSession"]',
      'const flushSession: Interface["flushSession"]',
    )
    // `requestFlushSession` re-arms the ONE shared scheduler, and that run takes
    // every eligible record — not only the requesting session's. So re-arming for
    // a session with no queued work would pull an unrelated session's work out of
    // the debounce and delivery windows it was deliberately left in.
    const check = body.indexOf("pendingSessionCount.has(session)")
    assert(check !== -1, "the request must consult the pending-session index")
    assert(check < body.indexOf("urgent.add(session)"), "the presence check must precede the urgency mutation")
    assert(check < body.indexOf("armLocked(0)"), "the presence check must precede the re-arm")
    // The no-work path is a true no-op: it cannot cancel, fork, or mark.
    const early = body.slice(
      body.indexOf("if (!pendingSessionCount.has(session)) return"),
      body.indexOf("if (urgent.has(session)) return"),
    )
    expect(early).not.toContain("urgent.")
    expect(early).not.toContain("cancelTimer")
    expect(early).not.toContain("armLocked")
    expect(early).not.toContain("forkIn")
    // A session that DOES have queued work still takes the full path: the index
    // filters, it never gates delivery.
    expect(body).toContain("urgent.add(session)")
    expect(body).toContain("armLocked(0)")
  })

  test("a duplicate request for an already-urgent session does not re-arm again", async () => {
    const body = section(
      await source(),
      'const requestFlushSession: Interface["requestFlushSession"]',
      'const flushSession: Interface["flushSession"]',
    )
    // The first request already recorded the marker and re-armed the one
    // scheduler, which is then armed or delivering. A duplicate Idle for the same
    // pending session has nothing left to ask for, so it must return before any
    // urgency mutation and before the re-arm: repeating the cancel/fork is pure
    // churn on the host's hottest lifecycle call, and a duplicate Idle event is
    // exactly what produces one.
    const duplicate = body.indexOf("if (urgent.has(session)) return")
    assert(duplicate !== -1, "an already-urgent session must be detected")
    assert(duplicate < body.indexOf("urgent.add(session)"), "the duplicate check must precede the marker mutation")
    assert(duplicate < body.indexOf("armLocked(0)"), "the duplicate check must precede the re-arm")
    // It comes after the no-work probe, so a session that owns nothing is not even
    // asked whether it is urgent and cannot leave a marker behind either.
    expect(body.indexOf("if (!pendingSessionCount.has(session)) return")).toBeLessThan(duplicate)
    // A duplicate mutates no state at all: its whole body is the early return.
    const statement = body.slice(duplicate, duplicate + "if (urgent.has(session)) return".length)
    expect(statement).toBe("if (urgent.has(session)) return")
    const after = body.slice(duplicate, body.indexOf("urgent.add(session)"))
    expect(after).not.toContain("cancelTimer")
    expect(after).not.toContain("armLocked")
    expect(after).not.toContain("forkIn")
    // Exactly one marker write and one re-arm exist in the whole entry point, so a
    // duplicate cannot be a second one in disguise.
    expect(body.match(/urgent\.add\(session\)/g) ?? []).toHaveLength(1)
    expect(body.match(/armLocked\(0\)/g) ?? []).toHaveLength(1)
  })

  test("a full drain consumes the urgency markers with the queue", async () => {
    const text = await source()
    const takeAll = section(text, "const takeAll = Effect.sync(() => {", "const takeEligible")
    // Semantics, not tidiness: every marker names a session whose work has just
    // left the queue, so a marker surviving a full drain would make the next
    // legitimate immediate request for that session look like a duplicate — and
    // that request would return without arming anything, stranding the new work
    // until the ordinary debounce.
    expect(takeAll).toContain("urgent.clear()")
    // Every full-queue path shares this one drain, so none of them can leave a
    // stale marker behind.
    for (const [start, end] of [
      ['const flush: Interface["flush"]', 'const requestFlushSession: Interface["requestFlushSession"]'],
      ["const clearTransientState = Effect.fnUntraced", 'const setEnabled: Interface["setEnabled"]'],
      ["finalize: Effect.gen", "satisfies ProcessRuntime"],
    ] as const) {
      expect(section(text, start, end)).toContain("takeAll")
    }
  })

  test("the pending-session index is derived from the queue, O(1), and bounded by it", async () => {
    const text = await source()
    expect(text).toContain("const pendingSessionCount = new Map<string, number>()")
    const claim = section(text, "const claimPendingSession = (activity: Activity) => {", "const releasePendingSession")
    // One increment, one map write, no scan: enqueue stays O(1). A record with
    // no session is not attributable to one, so it owns no index state at all.
    expect(claim).toContain("if (!session) return")
    expect(claim).toContain("pendingSessionCount.set(session, (pendingSessionCount.get(session) ?? 0) + 1)")
    expect(claim).not.toMatch(/for \(/)
    const release = section(text, "const releasePendingSession = (activity: Activity) => {", "const dropPending")
    // A session leaves the index exactly when its last entry leaves the queue,
    // so cardinality is bounded by the queue and needs no second cap.
    expect(release).toContain("if (!session) return")
    expect(release).toContain("(pendingSessionCount.get(session) ?? 0) - 1")
    expect(release).toContain("pendingSessionCount.delete(session)")

    const record = section(text, 'const record: Interface["record"]', 'const flush: Interface["flush"]')
    // Only a genuinely new key is a new queued entry, so coalescing onto an
    // existing key cannot double-count the session.
    expect(record).toContain("const coalesced = pending.get(key)")
    expect(record.indexOf("if (coalesced === undefined) claimPendingSession(activity)")).toBeGreaterThan(
      record.indexOf("pending.set(key,"),
    )
    // Eviction retires the evicted entry's OWN session, so a later Idle request
    // for that session cannot wake a scheduler for work that no longer exists.
    const eviction = record.slice(record.indexOf("if (oldest !== undefined && oldest !== key) {"))
    expect(eviction).toContain("dropPending(oldest, false)")
    expect(record).not.toContain("pending.delete(oldest)")
  })

  test("every exit from the queue retires the session it owned exactly once", async () => {
    const text = await source()
    // One extraction path unlinks an entry, detaches replay ownership, and
    // retires its session exactly once. Delivery outcome is settled separately
    // only after that detached snapshot leaves the queue.
    const take = section(text, "const takePending = (key: string): TakenActivity | undefined => {", "const dropPending")
    expect(take).toContain("pending.delete(key)")
    expect(take).toContain("detachPendingReplay(key)")
    expect(take).toContain("releasePendingSession(activity)")
    expect(take).toContain("return { activity, replayFingerprints }")
    const drop = section(text, "const dropPending = (key: string, attempted: boolean) => {", "const takeAll")
    expect(drop).toContain("const taken = takePending(key)")
    expect(drop).toContain("settleTakenReplay(taken, attempted)")
    for (const [start, end] of [
      ["const takeEligible = Effect.sync(() => {", "const takeForSession"],
      ["const takeForSession = (sessionID: string) =>", "const deliver"],
    ] as const) {
      expect(section(text, start, end)).toContain("takePending(key)")
    }
    expect(
      section(text, 'const record: Interface["record"]', 'const flush: Interface["flush"]'),
    ).toContain("dropPending(oldest, false)")
    // `takeAll` empties the whole queue at once, and it is the one path the
    // explicit flush, the opt-out clear, and the runtime finalizer all share —
    // so opt-out and teardown need no separate index bookkeeping.
    expect(section(text, "const takeAll = Effect.sync(() => {", "const takeEligible")).toContain(
      "pendingSessionCount.clear()",
    )
    expect(
      section(text, "const clearTransientState = Effect.fnUntraced", 'const setEnabled: Interface["setEnabled"]'),
    ).toContain("takeAll")
    expect(section(text, "finalize: Effect.gen", "satisfies ProcessRuntime")).toContain("takeAll")
  })

  test("delivery admission has exactly one implementation", async () => {
    const text = await source()
    // The cached probe is the only admission path. An uncached twin would be a
    // second per-delivery ~/.wakatime.cfg stat waiting to be wired back in.
    expect(text).toContain("const deliverableCached = () =>")
    expect(text).not.toMatch(/const deliverable\b/)
    expect(text).not.toContain("const deliverable =")
    // `status()` is the deliberate escape from that cache: a person asking
    // re-probes and writes the answer back.
    const status = section(text, 'const status: Interface["status"]', "const service: Interface")
    expect(status).toContain("yield* configured()")
    expect(status).not.toContain("configuredCached")
  })

  test("the ordinary debounce allocates no urgency snapshot", async () => {
    const take = section(await source(), "const takeEligible = Effect.sync(() => {", "const takeForSession")
    // A coding burst with no session request is the hot path and must not pay
    // for a Set copy on every window.
    expect(take).toContain("const urgentNow = urgent.size > 0 ? new Set(urgent) : undefined")
    expect(take).toContain("if (urgentNow) urgent.clear()")
    expect(take).toContain("urgentNow !== undefined && urgentNow.has(")
  })

  test("exactly one scheduler fiber exists, and a burst cannot multiply it", async () => {
    const text = await source()
    const arm = section(text, "let armLocked!", 'const record: Interface["record"]')
    // The delivering fast path must return before it can cancel or fork anything.
    // The scheduler keeps the single slot through its delivery, so a request
    // arriving meanwhile is O(1) state rather than a second fiber that would take
    // another batch and queue behind the delivery permit.
    const fast = arm.slice(arm.indexOf("if (delivering) {"), arm.indexOf("yield* cancelTimer()"))
    expect(fast).toContain("wake = wake === undefined ? requested : Math.min(wake, requested)")
    expect(fast).not.toContain("cancelTimer")
    expect(fast).not.toContain("forkIn")
    // The slot is released only after delivery, and the re-arm decision is made
    // exactly once, from the held deadline plus any deferred request.
    expect(arm.indexOf("timer !== undefined) timer = undefined")).toBeGreaterThan(arm.indexOf("deliver(taken.ready)"))
    expect(arm).toContain("const requestedWake = taken.moreReady ? 0 : wake")
    expect(arm).toContain("wake = undefined")
    expect(arm).toContain("decideNextDelay(requestedWake, taken.heldUntil)")
    // A cancelled scheduler cannot resurrect itself: ownership is proven by epoch.
    expect(arm).toContain("if (epoch !== ownedEpoch) {")
    // Ownership must be checked BEFORE clearing the shared timer slot. A newer
    // scheduler may have been installed after this fiber's epoch was invalidated;
    // a stale fiber must return without erasing that replacement.
    expect(arm.indexOf("if (epoch !== ownedEpoch) {")).toBeLessThan(
      arm.indexOf("if (timer !== undefined) timer = undefined"),
    )
    // The earlier of a held deadline and a deferred request wins, so a held
    // deadline is never pushed later by an arriving record.
    const decide = section(text, "const decideNextDelay = (requested", "let armLocked!")
    expect(decide).toContain("return Math.min(requested, held)")
    // Exactly two forks exist in the module and both are process-scoped: the one
    // scheduler and the one CodingActivity consumer.
    expect(text.match(/Effect\.forkIn\(/g) ?? []).toHaveLength(2)
    for (const fork of text.match(/Effect\.forkIn\([^,)]+/g) ?? []) expect(fork).toContain("processScope")
  })

  test("one scheduler and one bounded urgency set serve every session", async () => {
    const text = await source()
    // A session request must not add a fiber or a timer of its own.
    const request = section(text, 'const requestFlushSession: Interface["requestFlushSession"]', 'const flushSession: Interface["flushSession"]')
    expect(request).not.toContain("forkIn")
    expect(request).not.toContain("Effect.fork")
    expect(request).not.toContain("Effect.sleep")
    // N sessions still resolve through the single debounce scheduler.
    const forks = text.match(/Effect\.forkIn\([^,)]+/g) ?? []
    expect(forks).toHaveLength(2)
    for (const fork of forks) expect(fork).toContain("processScope")
    // The markers are consumed by the one scheduler run, so an idle session
    // cannot leave a marker accumulating behind it. An ordinary burst with no
    // request allocates no snapshot at all.
    const take = section(text, "const takeEligible = Effect.sync(() => {", "const takeForSession")
    expect(take).toContain("const urgentNow = urgent.size > 0 ? new Set(urgent) : undefined")
    expect(take).toContain("if (urgentNow) urgent.clear()")
  })

  test("only an urgent session bypasses the project limiter", async () => {
    const take = section(await source(), "const takeEligible = Effect.sync(() => {", "const takeForSession")
    expect(take).toContain("urgentNow.has((activity.aiSession ?? \"\").trim())")
    // A held record is still branched away from and left queued, so accelerating
    // one session never costs another.
    expect(take).toContain("heldUntil = Math.max(heldUntil, remaining)")
    expect(take.indexOf("if (remaining > 0)")).toBeLessThan(take.indexOf("takePending(key)"))
    expect(take).toContain("ready.push(taken)")
  })

  test("a blank selector is a no-op on both session entry points", async () => {
    const text = await source()
    // Each entry point trims and fails closed rather than guessing a session.
    expect(
      section(
        text,
        'const requestFlushSession: Interface["requestFlushSession"]',
        'const flushSession: Interface["flushSession"]',
      ),
    ).toContain("const session = sessionID.trim()")
    const take = section(text, "const takeForSession = (sessionID: string) =>", "const deliver")
    expect(take).toContain("const session = sessionID.trim()")
    expect(take).toContain("if (!session) return []")
    expect(
      section(
        text,
        'const requestFlushSession: Interface["requestFlushSession"]',
        'const flushSession: Interface["flushSession"]',
      ),
    ).toContain("if (!session) return")
  })
})

describe("WakaTime wire project identity", () => {
  test("an extra heartbeat carries no project field the CLI could act on", async () => {
    const body = section(await source(), "function extraHeartbeat", "function heartbeatArgs")
    // `alternate_project` is a project-NAME override in the WakaTime CLI, not a
    // project-folder field, so emitting it would let one queued observation
    // rename or re-route WakaTime's own project detection and mapping.
    expect(body).not.toContain("alternate_project")
    expect(body).not.toContain("projectFolder")
    expect(body).not.toContain("path.basename")
  })

  test("project identity reaches the CLI only through the invocation itself", async () => {
    const text = await source()
    const args = section(text, "function heartbeatArgs", "interface ProcessRuntime")
    expect(args).toContain('"--project-folder", activity.projectFolder')
    const send = section(text, "const send = Effect.fn", "const takeAll")
    expect(send).toContain("cwd: first.projectFolder")
  })
})

describe("WakaTime managed CLI freshness", () => {
  test("persists only non-secret version and check metadata", () => {
    expect(path.basename(WakaTime.cliStateFile())).toBe("wakatime-cli.json")
    expect(path.dirname(WakaTime.cliStateFile())).toContain("openfork")
    expect(WakaTime.parseManagedState({ checkedAt: 10, version: "1.4.0", apiKey: "secret" })).toEqual({
      checkedAt: 10,
      version: "1.4.0",
    })
    expect(WakaTime.parseManagedState(undefined)).toEqual({ checkedAt: 0 })
    expect(WakaTime.parseManagedState("not json")).toEqual({ checkedAt: 0 })
    expect(WakaTime.parseManagedState({ checkedAt: -5, version: "   " })).toEqual({ checkedAt: 0 })
  })

  test("bounds a freshness check to at most one attempt every four hours", () => {
    expect(WakaTime.MANAGED_CHECK_INTERVAL_MS).toBe(4 * 60 * 60 * 1_000)
    const now = 10 * WakaTime.MANAGED_CHECK_INTERVAL_MS
    // A state that has never recorded a check is always due.
    expect(WakaTime.managedCheckDue(WakaTime.DEFAULT_MANAGED_STATE, now)).toBe(true)
    expect(WakaTime.managedCheckDue({ checkedAt: now - 1 }, now)).toBe(false)
    expect(WakaTime.managedCheckDue({ checkedAt: now - WakaTime.MANAGED_CHECK_INTERVAL_MS + 1 }, now)).toBe(false)
    expect(WakaTime.managedCheckDue({ checkedAt: now - WakaTime.MANAGED_CHECK_INTERVAL_MS }, now)).toBe(true)
    // A failed check records the attempt too, so an unreachable network cannot
    // turn every heartbeat into a check.
    expect(
      WakaTime.managedCheckDue({ checkedAt: now - WakaTime.MANAGED_CHECK_INTERVAL_MS / 2, version: "1.4.0" }, now),
    ).toBe(false)
  })

  test("reads the upstream release defensively, keeping the exact tag", () => {
    // The tag is the asset-URL path segment, so it is preserved verbatim; the
    // version is the comparable form and is never used to build a URL.
    expect(WakaTime.parseLatestRelease('{"tag_name":"v1.4.0"}')).toEqual({ tag: "v1.4.0", version: "1.4.0" })
    expect(WakaTime.parseLatestRelease('{"tag_name":" release-9 "}')).toEqual({
      tag: "release-9",
      version: "release-9",
    })
    // A tag that is not `v`-prefixed must not lose itself by normalization.
    expect(WakaTime.parseLatestRelease('{"tag_name":"1.4.0"}')?.version).toBe("1.4.0")
    // An unreadable answer is not evidence of a release, so nothing is replaced.
    expect(WakaTime.parseLatestRelease("not json")).toBeUndefined()
    expect(WakaTime.parseLatestRelease("{}")).toBeUndefined()
    expect(WakaTime.parseLatestRelease('{"tag_name":"v"}')?.version).toBe("v")
    expect(WakaTime.parseLatestRelease('{"tag_name":"   "}')).toBeUndefined()
    expect(WakaTime.parseLatestRelease("null")).toBeUndefined()
  })

  test("managed assets are pinned to the observed release, never the latest pointer", async () => {
    const text = await source()
    // `/releases/latest/download` resolves per request, so a release published
    // between the metadata fetch and the asset fetch could serve a manifest for
    // one release and an archive for another.
    expect(text).not.toContain("/releases/latest/")
    expect(text).toContain("function releaseUrl")
    expect(text).toContain("encodeURIComponent(tag)")
    const install = section(text, "const fetchVerifiedCandidate = Effect.fn", "const commitCandidate")
    // Both the manifest and the archive address the same observed tag.
    expect(install).toContain('releaseUrl(release.tag, "checksums_sha256.txt")')
    expect(install).toContain("releaseUrl(release.tag, asset.archive)")
    // The raw tag is what the install receives; only the version is normalized.
    // The exact tag is carried from the metadata read to both asset fetches by
    // the one candidate producer, and that candidate still has to win the
    // compare-and-swap before anything is installed.
    const refresh = section(text, "const refreshManaged = Effect.fn", "const resolveUncached")
    expect(refresh.indexOf("fetchVerifiedCandidate()")).toBeLessThan(refresh.indexOf("commitCandidate("))
  })

  test("verifies the published SHA-256 before any bytes can be installed", () => {
    const payload = new TextEncoder().encode("#!/bin/sh\necho wakatime\n")
    const archive = zip([{ name: "wakatime-cli-linux-amd64", data: payload, method: 0 }])
    const asset = { binary: "wakatime-cli-linux-amd64", archive: "wakatime-cli-linux-amd64.zip" }
    const digest = createHash("sha256").update(archive).digest("hex")

    expect(WakaTime.verifyReleaseArchive(`${digest}  wakatime-cli-linux-amd64.zip\n`, archive, asset)).toEqual(payload)
    // A substituted archive is rejected on the digest, before extraction, so it
    // can never produce a replacement binary.
    expect(() =>
      WakaTime.verifyReleaseArchive(`${"0".repeat(64)}  wakatime-cli-linux-amd64.zip\n`, archive, asset),
    ).toThrow(/checksum mismatch/)
    expect(() => WakaTime.verifyReleaseArchive("# empty manifest\n", archive, asset)).toThrow(/did not contain/)
  })

  test("only the managed binary is ever auto-updated", async () => {
    const text = await source()
    const resolve = section(text, "const resolveUncached", "const resolveBinary =")
    // Background delivery preserves override > system > managed precedence:
    // override/system binaries are returned untouched. The extra
    // forceInitialInstall branch exists only for the explicit user-enable path;
    // when false, a managed binary is still the only source that reaches the
    // bounded refresh machinery.
    expect(resolve).toContain('if (probed && (forceInitialInstall || probed.source !== "managed")) return probed')
    expect(resolve).toContain("refreshManaged(probed, forceInitialInstall && probed === undefined)")
    // The check runs on the delivery path, not on the probe.
    expect(section(text, "const probeBinary", "const refreshManaged")).not.toContain("refreshManaged")
  })

  test("a failed managed update keeps the installed binary and cannot fail the caller", async () => {
    const text = await source()
    const replace = section(text, "const replaceManaged", "const fetchVerifiedCandidate")
    // Verified bytes land on a sibling temp file and are renamed into place, so
    // a failure anywhere leaves the previous binary exactly as usable.
    expect(replace).toContain(".new`")
    expect(replace).toContain("fs.rename(temporary, target)")
    expect(replace).toContain("fs.remove(temporary)")
    // Failure is reported by return value, not by failing the effect, and the
    // freshness check swallows its own failure so telemetry never sees it.
    expect(replace).toContain("Effect.logWarning")
    const refresh = section(text, "const refreshManaged = Effect.fn", "const resolveUncached")
    expect(refresh).toContain("Effect.exit")
    expect(refresh).toContain("keeping the installed binary")
    // A failed attempt is published through the same compare-and-swap, so it
    // cannot roll back a peer that got further.
    expect(refresh).toContain("publishSpentAttempt(observed, now)")
  })

  test("a cached managed binary stays eligible for its bounded check", async () => {
    const text = await source()
    const resolve = section(text, "const resolveBinary = () =>", "const prepareBinary = () =>")
    // Memoizing the resolved binary unconditionally would make a managed binary
    // stale for the life of the process. The override/system early return is the
    // only short-circuit, and a managed binary re-enters the check every time.
    expect(resolve).toContain('if (settled.source !== "managed") return Effect.succeed(settled)')
    expect(resolve).toContain("refreshManaged(settled)")
    expect(resolve).not.toMatch(/if \(resolved\) return/)

    // The explicit settings action is intentionally different: it may reuse a
    // resolved CLI immediately rather than turning a checkbox mutation into an
    // update check.
    const prepare = section(text, "const prepareBinary = () =>", "const send = Effect.fn")
    expect(prepare).toContain("if (resolved) return Effect.succeed(resolved)")
    expect(prepare).toContain("resolveUncached(true)")
  })

  test("an unknown installed version is refreshed, not merely recorded", async () => {
    const refresh = section(await source(), "const refreshManaged", "const resolveUncached")
    // Freshness is provable only against a recorded version AND an installed
    // binary. With no recorded version the binary's age is unknown, so recording
    // the latest and installing nothing would leave it stale until the next
    // release: the latest is installed once and becomes the new baseline.
    expect(refresh).toContain("commitCandidate(observed")
    const commit = section(await source(), "const commitCandidate = Effect.fn", "const publishSpentAttempt")
    expect(commit).toContain('if (current?.source === "managed" && observed.version === version)')
    // The install of a verified candidate and the timestamp publication are one
    // transaction; a failed install publishes the attempt instead of the version.
    expect(commit).toContain("const installed = yield* replaceManaged(candidate.binary)")
    expect(commit).toContain("lastCheck = { checkedAt: now, version }")
  })

  test("the binary swap and the state publication share one commit lock", async () => {
    const text = await source()
    const commit = section(text, "const commitCandidate = Effect.fn", "const publishSpentAttempt")
    // The whole compare-and-commit is inside the single cross-process lock.
    expect(commit).toContain("updateLock(")
    const compare = commit.indexOf("supersededByPeer(observed, latest)")
    expect(compare).toBeGreaterThan(commit.indexOf("updateLock("))
    expect(compare).toBeLessThan(commit.indexOf("replaceManaged("))
    // The swap and the publication are both inside that one critical section.
    const swap = commit.indexOf("replaceManaged(")
    // The version that accompanies a successful swap is published after it, in
    // the same critical section.
    expect(commit.lastIndexOf("writeManagedStateUnlocked({ checkedAt: now, version })")).toBeGreaterThan(swap)
    expect((commit.match(/writeManagedStateUnlocked\(/g) ?? []).length).toBeGreaterThanOrEqual(3)
    // There is exactly one lock for managed state, so lock ordering cannot be
    // violated and a nested acquisition cannot deadlock.
    expect(text.match(/wakatime-cli-update:/g) ?? []).toHaveLength(1)
    expect(text).not.toContain("wakatime-cli-state:")
    expect(text).toContain("const writeManagedStateUnlocked = Effect.fnUntraced")
    // The download stays outside the lock: a slow fetch must not block a peer.
    expect(section(text, "const fetchVerifiedCandidate = Effect.fn", "const commitCandidate")).not.toContain(
      "updateLock",
    )
    expect(section(text, "const replaceManaged = Effect.fnUntraced", "const fetchVerifiedCandidate")).not.toContain(
      "Flock.effect",
    )
  })

  test("the download is bounded while streaming, not checked afterwards", async () => {
    const text = await source()
    const fetch = section(text, "const fetchBytes = Effect.fn", "const fetchText")
    // The shared Core primitive is reused rather than reimplemented here; it
    // pre-rejects an over-declared Content-Length and fails an undeclared body
    // the moment it crosses, and the primitive's own tests prove those semantics.
    expect(text).toContain('from "./tool/http-body"')
    expect(fetch).toContain("collectBoundedResponseBody(")
    expect(fetch).toContain("MAX_ARCHIVE_BYTES,")
    // Materializing the whole body first and checking its length afterwards is
    // exactly the unbounded allocation this replaces.
    expect(fetch).not.toContain("response.arrayBuffer")
    // Every URL goes through the same collector, so the metadata and the checksum
    // manifest are bounded by the same limit as the archive.
    expect(text).toContain("fetchText = (url: string) => fetchBytes(url)")
    // The timeout is outside the collector, so it covers the body stream too and
    // not merely the response headers.
    expect(fetch.indexOf("collectBoundedResponseBody(")).toBeLessThan(
      fetch.indexOf("Effect.timeout(MANAGED_HTTP_TIMEOUT)"),
    )
    expect(WakaTime.MAX_ARCHIVE_BYTES).toBeGreaterThan(0)
  })
  test("managed-update HTTP work is bounded in time and in concurrency", async () => {
    const text = await source()
    expect(typeof WakaTime.MANAGED_HTTP_TIMEOUT).toBe("string")
    expect(WakaTime.MANAGED_HTTP_TIMEOUT.length).toBeGreaterThan(0)
    const fetch = section(text, "const fetchBytes = Effect.fn", "const fetchText")
    // Size limits alone would let a hung request hold the single delivery permit
    // and stop telemetry, so the request is bounded in time around body
    // consumption too.
    expect(fetch).toContain("Effect.timeout(MANAGED_HTTP_TIMEOUT)")
    expect(fetch).toContain("collectBoundedResponseBody(")
    expect(fetch.indexOf("collectBoundedResponseBody(")).toBeLessThan(fetch.indexOf("Effect.timeout("))
    // Exactly two asset requests, issued together.
    const candidate = section(text, "const fetchVerifiedCandidate = Effect.fn", "const commitCandidate")
    expect(candidate).toContain("{ concurrency: 2 }")
    expect(candidate).not.toContain('concurrency: "unbounded"')
  })

  test("an unavailable commit lock cannot repeat the network work", async () => {
    const spent = section(await source(), "const publishSpentAttempt", "const refreshManaged = Effect.fn")
    // The in-memory window is consumed before the lock is even attempted, so a
    // peer holding the lock cannot make every heartbeat re-run the check.
    expect(spent.indexOf("lastCheck = spent")).toBeLessThan(
      spent.indexOf("updateLock("),
    )
    // Persisting is best effort and still guarded by the same compare.
    expect(spent).toContain("supersededByPeer(observed, latest)")
    expect(spent).toContain("backing off in memory only")
  })

  test("a peer that installed after our probe is adopted rather than failed", async () => {
    const refresh = section(await source(), "const refreshManaged = Effect.fn", "const resolveUncached")
    // Only on the branch where persisted state says a check already happened and
    // we have no binary: rare, and off the hot path.
    expect(refresh).toContain("if (current === undefined) {")
    expect(refresh).toContain("const adopted = yield* probeBinary()")
    expect(refresh).toContain('if (adopted?.source === "managed") return adopted')
  })

  test("queued replay ownership is bounded and released on both exits", async () => {
    const text = await source()
    const detach = section(
      text,
      "const detachPendingReplay = (key: string) => {",
      "const settleTakenReplay = (taken: TakenActivity, attempted: boolean) => {",
    )
    // One entry may own several fingerprints, because several distinct
    // authoritative calls can coalesce onto it before delivery.
    expect(detach).toContain("const fingerprints = [...owned]")
    expect(detach).toContain("replayOwner.delete(fingerprint)")
    // Detachment alone never decides delivery outcome; that decision is delayed
    // until the batch knows whether a real CLI attempt happened.
    expect(detach).not.toContain("seen.delete(fingerprint)")
    const settle = section(
      text,
      "const settleTakenReplay = (taken: TakenActivity, attempted: boolean) => {",
      "const pendingSessionOf",
    )
    expect(settle).toContain("if (attempted) return")
    expect(settle).toContain("seen.delete(fingerprint)")

    const record = section(text, 'const record: Interface["record"]', 'const flush: Interface["flush"]')
    // Ownership is recorded on accept, and a fingerprint evicted from the global
    // recent window stops claiming its queued entry in O(1).
    expect(record).toContain("pendingReplay.set(key, owned)")
    expect(record).toContain("replayOwner.set(fingerprint, key)")
    expect(record).toContain("const owner = replayOwner.get(oldest)")
    expect(record).toContain("if (ownedByOwner.size === 0) pendingReplay.delete(owner)")
    // Eviction under queue pressure retires every reference the entry owned.
    expect(record).toContain("dropPending(oldest, false)")
    // The ordinary path is O(1): no scan walks the association sets on enqueue.
    expect(record.indexOf("owned.add(fingerprint)")).toBeLessThan(record.indexOf("pending.set(key,"))
    expect(record).not.toMatch(/for \(const .* of owned\)/)

    // Every exit from the queue moves ownership into a TakenActivity snapshot;
    // no extraction path is allowed to pre-commit the entry as delivered.
    expect(section(text, "const takeAll = Effect.sync(() => {", "const takeEligible")).toContain("takePending(key)")
    for (const [start, end] of [
      ["const takeEligible = Effect.sync(() => {", "const takeForSession"],
      ["const takeForSession = (sessionID: string) =>", "const deliver"],
    ] as const) {
      expect(section(text, start, end)).toContain("takePending(key)")
    }

    const deliver = section(text, "const deliver = Effect.fnUntraced", "const cancelTimer")
    // Missing prerequisites free every detached replay token and open no attempt
    // semantics. Real groups are committed only at the delivery boundary, and
    // interruption frees every group that never reached it.
    expect(deliver).toContain("if (binary === undefined) {")
    expect(deliver).toContain("settle(batch, false)")
    expect(deliver).toContain("settle(group.items, true)")
    expect(deliver).toContain("settle([...unsettled], false)")
    expect(deliver.indexOf("prepareDelivery()")).toBeLessThan(deliver.indexOf("openWindow(group.project)"))

    // Total association membership cannot exceed the global replay bound,
    // because an owned fingerprint is always also present in `seen`.
    expect(WakaTime.REPLAY_DEDUPE_BOUND).toBeGreaterThan(0)
    expect(WakaTime.MAX_PENDING).toBeGreaterThan(0)
  })

  test("an evicted observation releases its replay fingerprint", async () => {
    const record = section(await source(), 'const record: Interface["record"]', 'const flush: Interface["flush"]')
    // O(1): one replay key recomputation and one Set delete, no scan. The
    // fingerprints of work that was actually delivered are never touched.
    // A single Set delete through the shared release helper, so the mechanism
    // exists in exactly one place.
    expect(record).toContain("dropPending(oldest, false)")
    expect(record).not.toContain("replayKey(evicted)")
    const eviction = record.slice(record.indexOf("if (oldest !== undefined && oldest !== key) {"))
    expect(eviction).toContain("dropPending(oldest, false)")
    // The eviction reuses the one removal path rather than hand-coding a
    // partial unlink, so it cannot forget the session or the fingerprints.
    expect(record).not.toContain("pending.delete(oldest)")
  })

  test("a stale candidate cannot downgrade a newer published state", () => {
    // Two contenders observe the same four-hour window. The newer decision
    // commits first; the older one is then a downgrade and must be discarded.
    const stale = { checkedAt: 1_000, version: "1.4.0" }
    const newer = { checkedAt: 2_000, version: "1.5.0" }

    expect(WakaTime.supersededByPeer(stale, newer)).toBe(true)
    // A peer that only refreshed the timestamp has still decided; the candidate
    // must not be committed over its answer either.
    expect(WakaTime.supersededByPeer(stale, { checkedAt: 2_000, version: "1.4.0" })).toBe(true)
    // The same decision in both processes is not a conflict, so a candidate is
    // allowed to commit over exactly the snapshot that justified it.
    expect(WakaTime.supersededByPeer(newer, newer)).toBe(false)
    expect(WakaTime.supersededByPeer(stale, stale)).toBe(false)
    // An unrecorded state is only ever matched by another unrecorded state.
    expect(
      WakaTime.supersededByPeer(WakaTime.DEFAULT_MANAGED_STATE, WakaTime.DEFAULT_MANAGED_STATE),
    ).toBe(false)
  })
})

describe("WakaTime release archive handling", () => {
  test("parses a sha256 manifest line for the requested asset", () => {
    const digest = "a".repeat(64)
    const manifest = `# comment\n${digest}  wakatime-cli-linux-amd64.zip\n${"b".repeat(64)} *other.zip\n`
    expect(WakaTime.parseChecksum(manifest, "wakatime-cli-linux-amd64.zip")).toBe(digest)
    expect(() => WakaTime.parseChecksum(manifest, "missing.zip")).toThrow(/did not contain/)
  })

  test("extracts a stored release entry through the central directory", () => {
    const payload = new TextEncoder().encode("#!/bin/sh\necho wakatime\n")
    const archive = zip([{ name: "wakatime-cli-linux-amd64", data: payload, method: 0 }])
    expect(WakaTime.extractReleaseBinary(archive, "wakatime-cli-linux-amd64")).toEqual(payload)
  })

  test("extracts a deflated release entry and tolerates a directory prefix", () => {
    const payload = new TextEncoder().encode("x".repeat(5_000))
    const archive = zip([{ name: "bin/wakatime-cli-linux-amd64", data: payload, method: 8 }])
    expect(WakaTime.extractReleaseBinary(archive, "wakatime-cli-linux-amd64")).toEqual(payload)
  })

  test("fails closed on a corrupt archive or a missing entry", () => {
    const archive = zip([{ name: "wakatime-cli-linux-amd64", data: new Uint8Array([1, 2, 3]), method: 0 }])
    expect(() => WakaTime.extractReleaseBinary(archive, "other")).toThrow(/did not contain/)
    expect(() => WakaTime.extractReleaseBinary(new Uint8Array(40), "any")).toThrow(
      /missing ZIP end-of-central-directory/,
    )
  })
})

/** Minimal stored/deflate ZIP writer matching the reader's central-directory layout. */
function zip(entries: readonly { name: string; data: Uint8Array; method: 0 | 8 }[]) {
  const encoder = new TextEncoder()
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0

  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const body = entry.method === 8 ? new Uint8Array(deflateRawSync(entry.data)) : entry.data
    const local = new Uint8Array(30 + name.length + body.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(8, entry.method, true)
    lv.setUint32(18, body.length, true)
    lv.setUint32(22, entry.data.length, true)
    lv.setUint16(26, name.length, true)
    local.set(name, 30)
    local.set(body, 30 + name.length)

    const central = new Uint8Array(46 + name.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(10, entry.method, true)
    cv.setUint32(20, body.length, true)
    cv.setUint32(24, entry.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    central.set(name, 46)

    locals.push(local)
    centrals.push(central)
    offset += local.length
  }

  const centralSize = centrals.reduce((total, item) => total + item.length, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)

  const out = new Uint8Array(offset + centralSize + eocd.length)
  let cursor = 0
  for (const part of [...locals, ...centrals, eocd]) {
    out.set(part, cursor)
    cursor += part.length
  }
  return out
}
