import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { OxpConfig } from "@/oxp/config"
import { OxpProcess } from "@/oxp/process"
import { OxpRoot } from "@/oxp/root"
import { OxpSchema } from "@/oxp/schema"
import { testEffect } from "../lib/effect"

const suite = path.join(os.tmpdir(), `opencode-oxp-process-${randomUUID()}`)
const configDir = path.join(suite, ".config")
const stateDir = path.join(suite, ".state")
const layer = AppNodeBuilder.build(
  LayerNode.group([OxpProcess.node, OxpRoot.node, OxpConfig.node]),
  [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
)
const it = testEffect(layer)

async function withFreshProcessRuntime<A>(
  run: (services: {
    proc: OxpProcess.Interface
    roots: OxpRoot.Interface
    config: OxpConfig.Interface
  }) => Effect.Effect<A, any>,
): Promise<A> {
  const fresh = AppNodeBuilder.build(
    LayerNode.group([OxpProcess.node, OxpRoot.node, OxpConfig.node]),
    [[Global.node, Global.layerWith({ config: configDir, state: stateDir })]],
  )
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(Layer.fresh(fresh))
        return yield* run({
          proc: Context.get(context, OxpProcess.Service),
          roots: Context.get(context, OxpRoot.Service),
          config: Context.get(context, OxpConfig.Service),
        })
      }),
    ),
  )
}

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpProcess", () => {
  test("recovers terminal process history across a fresh OXP runtime without recovering live authority", async () => {
    const rootDir = path.join(suite, "workspace")
    await fs.mkdir(rootDir)
    let handle = ""
    let rootID!: OxpSchema.RootID

    await withFreshProcessRuntime(({ proc, roots, config }) =>
      Effect.gen(function* () {
        const root = yield* roots.approve(rootDir)
        rootID = root.id
        yield* config.setEnabled(true)
        yield* config.setGrant({ process: true })
        const started = yield* proc.execute({
          action: "start",
          rootID,
          argv: [process.execPath, "-e", "process.stdout.write('RECOVERED_OUTPUT')"],
          mode: "foreground",
          yieldMs: 5_000,
        })
        handle = (started.structured as { handle: string }).handle
        expect(started.structured).toMatchObject({
          handle,
          running: false,
          output: "RECOVERED_OUTPUT",
        })
      }),
    )

    await withFreshProcessRuntime(({ proc }) =>
      Effect.gen(function* () {
        const status = yield* proc.execute({ action: "status", handle })
        expect(status.structured).toMatchObject({
          handle,
          running: false,
          recovered: true,
          output: "RECOVERED_OUTPUT",
        })

        const polled = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
        expect(polled.output).toBe("RECOVERED_OUTPUT")
        expect(polled.structured).toMatchObject({ recovered: true, running: false })

        const waited = yield* proc.execute({ action: "wait", handle, timeoutMs: 100, offset: 0, maxBytes: 64 })
        expect(waited.output).toBe("RECOVERED_OUTPUT")
        expect(waited.structured).toMatchObject({ recovered: true, running: false })

        const listed = yield* proc.execute({ action: "list", rootID })
        expect((listed.structured as { processes: Array<{ handle: string; recovered?: boolean }> }).processes)
          .toContainEqual(expect.objectContaining({ handle, recovered: true }))

        const write = yield* proc.execute({ action: "write", handle, chars: "nope" }).pipe(Effect.flip)
        expect(write._tag).toBe("OXP_CONFLICT")
        const kill = yield* proc.execute({ action: "kill", handle }).pipe(Effect.flip)
        expect(kill._tag).toBe("OXP_CONFLICT")

        const removed = yield* proc.execute({ action: "remove", handle })
        expect(removed.mutation).toEqual({ attempted: true, committed: true })
        const stale = yield* proc.execute({ action: "status", handle }).pipe(Effect.flip)
        expect(stale._tag).toBe("OXP_HANDLE_STALE")
      }),
    )
  }, 30_000)

  test("recovers a running background process only after the previous runtime retires it during disposal", async () => {
    const rootDir = path.join(suite, "workspace")
    await fs.mkdir(rootDir)
    let handle = ""
    let rootID!: OxpSchema.RootID

    await withFreshProcessRuntime(({ proc, roots, config }) =>
      Effect.gen(function* () {
        const root = yield* roots.approve(rootDir)
        rootID = root.id
        yield* config.setEnabled(true)
        yield* config.setGrant({ process: true })
        const started = yield* proc.execute({
          action: "start",
          rootID,
          argv: [
            process.execPath,
            "-e",
            "process.stdout.write('BACKGROUND_READY'); setTimeout(()=>{},30000)",
          ],
          mode: "background",
        })
        handle = (started.structured as { handle: string }).handle
        let poll = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
        for (let attempt = 0; attempt < 40 && poll.output !== "BACKGROUND_READY"; attempt++) {
          yield* Effect.sleep("50 millis")
          poll = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
        }
        expect(poll.output).toBe("BACKGROUND_READY")
        expect((yield* proc.execute({ action: "status", handle })).structured).toMatchObject({
          running: true,
        })
      }),
    )

    await withFreshProcessRuntime(({ proc }) =>
      Effect.gen(function* () {
        const status = yield* proc.execute({ action: "status", handle })
        expect(status.structured).toMatchObject({
          handle,
          running: false,
          recovered: true,
          output: "BACKGROUND_READY",
          terminationReason: "runtime-dispose",
        })
        const kill = yield* proc.execute({ action: "kill", handle }).pipe(Effect.flip)
        expect(kill._tag).toBe("OXP_CONFLICT")
      }),
    )
  }, 30_000)

  test("retries transient terminal archive failure and recovers the healed row in a fresh runtime", async () => {
    const rootDir = path.join(suite, "workspace")
    const archiveDir = path.join(stateDir, "oxp-process")
    const archiveBackup = path.join(stateDir, "oxp-process-backup")
    await fs.mkdir(rootDir)
    let handle = ""

    await withFreshProcessRuntime(({ proc, roots, config }) =>
      Effect.gen(function* () {
        const root = yield* roots.approve(rootDir)
        yield* config.setEnabled(true)
        yield* config.setGrant({ process: true })
        const started = yield* proc.execute({
          action: "start",
          rootID: root.id,
          argv: [
            process.execPath,
            "-e",
            "setTimeout(()=>process.stdout.write('RETRY_ARCHIVE_OK'),250)",
          ],
          mode: "background",
        })
        handle = (started.structured as { handle: string }).handle

        yield* Effect.promise(async () => {
          await fs.rename(archiveDir, archiveBackup)
          await fs.writeFile(archiveDir, "block archive publication")
        })
        yield* Effect.sleep("600 millis")

        const blocked = yield* proc.execute({ action: "status", handle })
        expect(blocked.structured).toMatchObject({ handle, running: false })

        yield* Effect.promise(async () => {
          await fs.rm(archiveDir, { force: true })
          await fs.rename(archiveBackup, archiveDir)
        })
        const healed = yield* proc.execute({ action: "status", handle })
        expect(healed.structured).toMatchObject({ handle, running: false })
      }),
    )

    await withFreshProcessRuntime(({ proc }) =>
      Effect.gen(function* () {
        const recovered = yield* proc.execute({ action: "status", handle })
        expect(recovered.structured).toMatchObject({
          handle,
          running: false,
          recovered: true,
          output: "RETRY_ARCHIVE_OK",
        })
      }),
    )
  }, 30_000)

  test("purges recovered terminal history when the approved root is replaced at the same path", async () => {
    const rootDir = path.join(suite, "workspace")
    const original = path.join(suite, "workspace-original")
    await fs.mkdir(rootDir)
    let handle = ""
    let supported = true

    await withFreshProcessRuntime(({ proc, roots, config }) =>
      Effect.gen(function* () {
        const root = yield* roots.approve(rootDir)
        if (!root.identityFingerprint) {
          supported = false
          return
        }
        yield* config.setEnabled(true)
        yield* config.setGrant({ process: true })
        const started = yield* proc.execute({
          action: "start",
          rootID: root.id,
          argv: [process.execPath, "-e", "process.stdout.write('ARCHIVED_BEFORE_ROOT_SWAP')"],
          mode: "foreground",
          yieldMs: 5_000,
        })
        handle = (started.structured as { handle: string }).handle
      }),
    )
    if (!supported) return

    await fs.rename(rootDir, original)
    await fs.mkdir(rootDir)

    await withFreshProcessRuntime(({ proc }) =>
      Effect.gen(function* () {
        let result = yield* proc.execute({ action: "status", handle }).pipe(
          Effect.map(() => "visible" as const),
          Effect.catch((error) => Effect.succeed(error._tag)),
        )
        for (let attempt = 0; attempt < 20 && result !== "OXP_HANDLE_STALE"; attempt++) {
          yield* Effect.sleep("250 millis")
          result = yield* proc.execute({ action: "status", handle }).pipe(
            Effect.map(() => "visible" as const),
            Effect.catch((error) => Effect.succeed(error._tag)),
          )
        }
        expect(result).toBe("OXP_HANDLE_STALE")
      }),
    )
  }, 30_000)

  test("persists intentional kill cause across a fresh runtime", async () => {
    const rootDir = path.join(suite, "workspace")
    await fs.mkdir(rootDir)
    let handle = ""

    await withFreshProcessRuntime(({ proc, roots, config }) =>
      Effect.gen(function* () {
        const root = yield* roots.approve(rootDir)
        yield* config.setEnabled(true)
        yield* config.setGrant({ process: true })
        const started = yield* proc.execute({
          action: "start",
          rootID: root.id,
          argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"],
          mode: "background",
        })
        handle = (started.structured as { handle: string }).handle
        const killed = yield* proc.execute({ action: "kill", handle })
        expect(killed.structured).toMatchObject({
          handle,
          running: false,
          terminationReason: "requested-kill",
        })
      }),
    )

    await withFreshProcessRuntime(({ proc }) =>
      Effect.gen(function* () {
        const recovered = yield* proc.execute({ action: "status", handle })
        expect(recovered.structured).toMatchObject({
          handle,
          running: false,
          recovered: true,
          terminationReason: "requested-kill",
        })
      }),
    )
  }, 30_000)

  it.live("publishes both start forms in one transport-safe schema", Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(OxpProcess.Parameters, { onExcessProperty: "error" })
    const argv = yield* decode({
      action: "start",
      rootID: OxpSchema.RootID.make("00000000-0000-4000-8000-000000000001"),
      argv: ["node", "-e", "process.stdout.write('ok')"],
    })
    expect("argv" in argv).toBe(true)
    const command = yield* decode({
      action: "start",
      rootID: OxpSchema.RootID.make("00000000-0000-4000-8000-000000000001"),
      command: "node --version",
    })
    expect("command" in command).toBe(true)
  }))

  it.live("normalizes host-valid transport supersets into one canonical process action", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const start = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [process.execPath, "-e", "process.stdout.write('argv-wins')"],
      command: "this command must never execute",
      shell: "ignored-shell",
      mode: "foreground",
      yieldMs: 5_000,
      timeoutMs: 120_000,
      maxBytes: 4_096,
    })
    expect(start.output).toBe("argv-wins")
    expect(start.metadata).toMatchObject({
      transportIgnored: ["command", "shell", "timeoutMs", "maxBytes"],
    })

    const handle = (start.structured as { handle: string }).handle
    const wait = yield* proc.execute({
      action: "wait",
      rootID: root.id,
      workdir: ".",
      handle,
      timeoutMs: 1_000,
    })
    expect(wait.metadata).toMatchObject({
      transportIgnored: ["rootID", "workdir"],
    })

    const poll = yield* proc.execute({
      action: "poll",
      rootID: root.id,
      handle,
      timeoutMs: 1_000,
      offset: 0,
      maxBytes: 4_096,
    })
    expect(poll.output).toContain("argv-wins")
    expect(poll.metadata).toMatchObject({
      transportIgnored: ["rootID", "timeoutMs"],
    })
  }))

  it.live("runs a foreground process without manufacturing a Session or exposing native root paths", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    const virtualRoot = roots.toVirtualPath(root, rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const result = yield* proc.execute({
      action: "start",
      rootID: root.id,
      command: process.platform === "win32" ? "echo OXP_PROCESS_OK" : "printf OXP_PROCESS_OK",
      mode: "foreground",
      yieldMs: 5000,
    })
    expect(result.output).toContain("OXP_PROCESS_OK")
    expect(result.mutation).toEqual({ attempted: true, committed: true })
    expect(result.structured).toMatchObject({ workdir: virtualRoot })
    expect(result.metadata).toMatchObject({ workdir: virtualRoot })
    expect(JSON.stringify(result)).not.toContain(rootDir)
  }))

  it.live("recovers terminal public process history across fresh OXP runtimes without resurrecting live authority", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [process.execPath, "-e", "process.stdout.write('OXP_RECOVERY_OK')"],
      mode: "foreground",
      yieldMs: 5_000,
    })
    const handle = (started.structured as { handle: string }).handle
    expect(started.output).toContain("OXP_RECOVERY_OK")

    // Build a genuinely fresh OXP service graph over the same durable
    // config/state. It has no ChildProcessHandle from the first runtime.
    const freshContext = yield* Layer.build(Layer.fresh(layer))
    const fresh = Context.get(freshContext, OxpProcess.Service)

    const listed = yield* fresh.execute({ action: "list", rootID: root.id })
    const rows = (listed.structured as {
      processes: Array<{ handle: string; recovered?: boolean; running?: boolean }>
    }).processes
    expect(rows).toContainEqual(expect.objectContaining({
      handle,
      recovered: true,
      running: false,
    }))

    const status = yield* fresh.execute({ action: "status", handle })
    expect(status.structured).toMatchObject({
      handle,
      recovered: true,
      running: false,
      output: "OXP_RECOVERY_OK",
    })
    const poll = yield* fresh.execute({ action: "poll", handle, offset: 0, maxBytes: 1024 })
    expect(poll.output).toBe("OXP_RECOVERY_OK")
    const waited = yield* fresh.execute({ action: "wait", handle, timeoutMs: 100 })
    expect(waited.output).toBe("OXP_RECOVERY_OK")
    expect(JSON.stringify({ listed, status, poll, waited })).not.toContain(rootDir)

    const writeDenied = yield* fresh.execute({
      action: "write",
      handle,
      chars: "must-not-write",
    }).pipe(Effect.flip)
    expect(writeDenied._tag).toBe("OXP_CONFLICT")
    const killDenied = yield* fresh.execute({ action: "kill", handle }).pipe(Effect.flip)
    expect(killDenied._tag).toBe("OXP_CONFLICT")

    const removed = yield* fresh.execute({ action: "remove", handle })
    expect(removed.mutation).toEqual({ attempted: true, committed: true })
    const stale = yield* fresh.execute({ action: "status", handle }).pipe(Effect.flip)
    expect(stale._tag).toBe("OXP_HANDLE_STALE")
  }), { timeout: 30_000 })

  it.live("never projects a still-live process as recovered during an overlapping runtime trial", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write('TRIAL_READY'); setTimeout(()=>{},30000)",
      ],
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle
    let livePoll = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    for (let attempt = 0; attempt < 40 && livePoll.output !== "TRIAL_READY"; attempt++) {
      yield* Effect.sleep("50 millis")
      livePoll = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    }
    expect(livePoll.output).toBe("TRIAL_READY")

    // Model Desktop's runtime-refresh trial: both service graphs are alive over
    // the same durable config/state, but only generation A owns the ChildProcessHandle.
    const candidateContext = yield* Layer.build(Layer.fresh(layer))
    const candidate = Context.get(candidateContext, OxpProcess.Service)
    const candidateList = yield* candidate.execute({ action: "list", rootID: root.id })
    expect(
      (candidateList.structured as { processes: Array<{ handle: string }> }).processes
        .some((row) => row.handle === handle),
    ).toBe(false)
    const candidateStatusWhileLive = yield* candidate
      .execute({ action: "status", handle })
      .pipe(Effect.flip)
    expect(candidateStatusWhileLive._tag).toBe("OXP_HANDLE_STALE")

    // Only after the owner proves retirement may the candidate observe a
    // terminal historical row. It still never gains live write/kill authority.
    yield* proc.execute({ action: "kill", handle })
    const recovered = yield* candidate.execute({ action: "status", handle })
    expect(recovered.structured).toMatchObject({
      handle,
      running: false,
      recovered: true,
      output: "TRIAL_READY",
    })
    const killDenied = yield* candidate.execute({ action: "kill", handle }).pipe(Effect.flip)
    expect(killDenied._tag).toBe("OXP_CONFLICT")
  }), { timeout: 30_000 })

  it.live("runs public argv starts without a shell and preserves exact argument boundaries", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const script = "process.stdout.write(JSON.stringify(process.argv.slice(1)))"
    const result = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [process.execPath, "-e", script, "a b", "\"quoted\""],
      mode: "foreground",
      yieldMs: 5_000,
    })
    expect(JSON.parse(result.output)).toEqual(["a b", "\"quoted\""])
    expect((result.structured as { handle?: string }).handle).toMatch(/^proc_/)
  }))

  it.live("captures short-lived foreground stdout under concurrent spawn pressure", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const outputs = yield* Effect.forEach(
      Array.from({ length: 12 }, (_, index) => index),
      (index) => {
        const marker = `OXP_FAST_${index}`
        const script = `process.stdout.write(${JSON.stringify(marker)})`
        const command =
          JSON.stringify(process.execPath) + " -e " + JSON.stringify(script)
        return proc.execute({
          action: "start",
          rootID: root.id,
          command,
          mode: "foreground",
          yieldMs: 5_000,
        }).pipe(Effect.map((result) => result.output))
      },
      { concurrency: "unbounded" },
    )

    expect(outputs).toEqual(
      Array.from({ length: 12 }, (_, index) => `OXP_FAST_${index}`),
    )
  }))

  it.live("reclaims settled handles at capacity instead of wedging future process starts", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    // MAX_HANDLES is 64. Completed handles intentionally remain queryable, but
    // they must never make the 65th+ authorized process start fail with OXP_BUSY.
    for (let index = 0; index < 64; index++) {
      const result = yield* proc.execute({
        action: "start",
        rootID: root.id,
        argv: [process.execPath, "-e", ""],
        mode: "foreground",
        yieldMs: 5_000,
      })
      expect(result.mutation).toEqual({ attempted: true, committed: true })
    }

    const atCapacity = yield* proc.execute({ action: "list", rootID: root.id })
    expect((atCapacity.structured as { processes: unknown[] }).processes).toHaveLength(64)

    // Capacity reconciliation deletes old settled capability handles. A request
    // that cannot prove root authority must not be allowed to trigger that
    // mutation merely because the registry happens to be full.
    const unauthorized = yield* proc.execute({
      action: "start",
      rootID: OxpSchema.RootID.make(randomUUID()),
      argv: [process.execPath, "-e", ""],
      mode: "foreground",
      yieldMs: 5_000,
    }).pipe(Effect.flip)
    expect(["OXP_ROOT_NOT_FOUND", "OXP_AUTH_DENIED"]).toContain(unauthorized._tag)
    const afterDenied = yield* proc.execute({ action: "list", rootID: root.id })
    expect((afterDenied.structured as { processes: unknown[] }).processes).toHaveLength(64)

    for (let index = 0; index < 2; index++) {
      const result = yield* proc.execute({
        action: "start",
        rootID: root.id,
        argv: [process.execPath, "-e", ""],
        mode: "foreground",
        yieldMs: 5_000,
      })
      expect(result.mutation).toEqual({ attempted: true, committed: true })
    }

    const listed = yield* proc.execute({ action: "list", rootID: root.id })
    const rows = (listed.structured as {
      processes: Array<{ recovered?: boolean }>
    }).processes
    expect(rows.filter((row) => row.recovered !== true).length).toBeLessThanOrEqual(64)
  }), { timeout: 30_000 })


  it.live("keeps the 64-handle cap hard under concurrent background admission", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const argv = (process.platform === "win32"
      ? ["ping.exe", "-n", "30", "127.0.0.1"]
      : ["sleep", "30"]) as [string, ...string[]]

    const attempts = yield* Effect.forEach(
      Array.from({ length: 65 }, (_, index) => index),
      () =>
        proc.execute({
          action: "start",
          rootID: root.id,
          argv,
          mode: "background",
        }).pipe(
          Effect.map((result) => ({ ok: true as const, result })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        ),
      { concurrency: "unbounded" },
    )
    const succeeded = attempts.filter((item): item is Extract<typeof item, { ok: true }> => item.ok)
    const failed = attempts.filter((item): item is Extract<typeof item, { ok: false }> => !item.ok)
    expect(succeeded.length).toBeLessThanOrEqual(64)
    expect(failed.some((item) => item.error._tag === "OXP_BUSY")).toBe(true)

    const listed = yield* proc.execute({ action: "list", rootID: root.id })
    expect((listed.structured as { processes: unknown[] }).processes.length).toBeLessThanOrEqual(64)
    yield* Effect.forEach(
      succeeded,
      (item) => {
        const handle = (item.result.structured as { handle: string }).handle
        return proc.execute({ action: "kill", handle }).pipe(Effect.ignore)
      },
      { concurrency: "unbounded", discard: true },
    )
  }), { timeout: 60_000 })

  it.live("returns opaque handles and actively retires owned trees when process authority is revoked", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const command = process.platform === "win32" ? "ping -n 30 127.0.0.1 >NUL" : "sleep 30"
    const started = yield* proc.execute({ action: "start", rootID: root.id, command, mode: "background" })
    const handle = (started.structured as { handle: string }).handle
    expect(handle).toMatch(/^proc_[A-Za-z0-9_-]+$/)
    expect(handle).not.toMatch(/^\d+$/)

    yield* config.setGrant({ process: false })
    yield* Effect.sleep("100 millis")
    const stale = yield* proc.execute({ action: "status", handle }).pipe(Effect.flip)
    expect(["OXP_HANDLE_STALE", "OXP_AUTH_DENIED"]).toContain(stale._tag)
  }))

  it.live("requires process grant and confines workdir to the approved root", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    const denied = yield* proc.execute({ action: "start", rootID: root.id, command: "echo nope" }).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_AUTH_DENIED")
    yield* config.setGrant({ process: true })
    const escape = yield* proc.execute({ action: "start", rootID: root.id, workdir: "../", command: "echo nope" }).pipe(Effect.flip)
    expect(escape._tag).toBe("OXP_PATH_ESCAPE")

    const nested = path.join(rootDir, "nested")
    yield* Effect.promise(() => fs.mkdir(nested))
    yield* Effect.promise(() => fs.writeFile(path.join(nested, "marker.txt"), "ok"))
    const virtualNested = roots.toVirtualPath(root, nested)
    const command =
      JSON.stringify(process.execPath) +
      ' -e "require(\'fs\').accessSync(\'marker.txt\');process.stdout.write(\'OXP_NESTED_WORKDIR_OK\')"'
    const scoped = yield* proc.execute({
      action: "start",
      rootID: root.id,
      workdir: "nested",
      command,
      mode: "foreground",
      yieldMs: 5_000,
    })
    expect(scoped.output).toContain("OXP_NESTED_WORKDIR_OK")
    expect(scoped.structured).toMatchObject({ workdir: virtualNested })
    expect(scoped.metadata).toMatchObject({ workdir: virtualNested })
    expect(JSON.stringify(scoped)).not.toContain(rootDir)
  }))

  it.live("does not expose ambient secret environment entries to model-authored processes", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const secretName = "OPENFORK_OXP_TEST_API_KEY"
    const publicName = "OPENFORK_OXP_TEST_PUBLIC"
    const priorSecret = process.env[secretName]
    const priorPublic = process.env[publicName]
    process.env[secretName] = "must-not-reach-child"
    process.env[publicName] = "visible"
    try {
      const script = `process.stdout.write(JSON.stringify({secret:Object.hasOwn(process.env,'${secretName}'),public:process.env.${publicName}}))`
      const command = JSON.stringify(process.execPath) + ` -e ${JSON.stringify(script)}`
      const result = yield* proc.execute({ action: "start", rootID: root.id, command, mode: "foreground", yieldMs: 5_000 })
      expect(result.output).toBe(JSON.stringify({ secret: false, public: "visible" }))
    } finally {
      if (priorSecret === undefined) delete process.env[secretName]
      else process.env[secretName] = priorSecret
      if (priorPublic === undefined) delete process.env[publicName]
      else process.env[publicName] = priorPublic
    }
  }))

  it.live("uses byte-exact UTF-8 poll continuation tokens", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const command = JSON.stringify(process.execPath) + ' -e "process.stdout.write(\'A🙂你好Z\')"'
    const started = yield* proc.execute({ action: "start", rootID: root.id, command, mode: "foreground", yieldMs: 5000 })
    const handle = (started.structured as { handle: string }).handle
    yield* Effect.sleep("50 millis")

    const first = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 5 })
    expect(first.output).toBe("A🙂")
    const next = Number(first.metadata?.nextOffset)
    expect(next).toBe(5)
    const second = yield* proc.execute({ action: "poll", handle, offset: next, maxBytes: 6 })
    expect(second.output).toBe("你好")
    expect(Number(second.metadata?.nextOffset)).toBe(11)
  }))

  it.live("requires explicit root scoping for process-list discovery", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const denied = yield* proc.execute({ action: "list" } as never).pipe(Effect.flip)
    expect(denied._tag).toBe("OXP_ROOT_REQUIRED")
    const listed = yield* proc.execute({ action: "list", rootID: root.id })
    expect(listed.structured).toEqual({ processes: [] })
  }))

  it.live("propagates request cancellation while waiting without making the handle the authority", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const command = JSON.stringify(process.execPath) + ' -e "setTimeout(()=>{},30000)"'
    const started = yield* proc.execute({ action: "start", rootID: root.id, command, mode: "background" })
    const handle = (started.structured as { handle: string }).handle
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 50)
    const cancelled = yield* proc.execute({ action: "wait", handle, timeoutMs: 5000 }, controller.signal).pipe(Effect.flip)
    clearTimeout(timer)
    expect(cancelled._tag).toBe("OXP_CANCELLED")

    const killed = yield* proc.execute({ action: "kill", handle })
    expect(killed.mutation).toEqual({ attempted: true, committed: true })
  }))

  it.live("returns captured stdout directly from wait so callers do not need a second poll", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const script = "setTimeout(()=>process.stdout.write('OXP_WAIT_OUTPUT_OK'),40)"
    const command = JSON.stringify(process.execPath) + " -e " + JSON.stringify(script)
    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      command,
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle

    const waited = yield* proc.execute({
      action: "wait",
      handle,
      timeoutMs: 5_000,
      maxBytes: 1024,
    })
    expect(waited.output).toContain("OXP_WAIT_OUTPUT_OK")
    expect(waited.structured).toMatchObject({
      running: false,
      exitCode: 0,
      output: "OXP_WAIT_OUTPUT_OK",
      offset: 0,
    })
    expect(waited.metadata).toMatchObject({ offset: 0 })
  }))

  it.live("includes a bounded captured-output preview in status", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const script = "process.stdout.write('x'.repeat(9000))"
    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [process.execPath, "-e", script],
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle
    yield* proc.execute({ action: "wait", handle, timeoutMs: 5_000, maxBytes: 32 })

    const status = yield* proc.execute({ action: "status", handle })
    const structured = status.structured as {
      output?: string
      offset?: number
      nextOffset?: number
      retainedBytes?: number
      pageTruncated?: boolean
      outputNextOffset?: number
      outputPreviewTruncated?: boolean
      running?: boolean
      exitCode?: number
    }
    expect(structured.running).toBe(false)
    expect(structured.exitCode).toBe(0)
    expect(Buffer.byteLength(structured.output ?? "", "utf8")).toBe(8 * 1024)
    expect(structured).toMatchObject({
      offset: 0,
      nextOffset: 8 * 1024,
      retainedBytes: 9000,
      pageTruncated: true,
    })
    expect(structured.outputNextOffset).toBe(8 * 1024)
    expect(structured.outputPreviewTruncated).toBe(true)
    expect(status.metadata).not.toHaveProperty("output")
  }))

  it.live("writes raw continuation bytes through an opaque owned handle", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const command =
      JSON.stringify(process.execPath) +
      ' -e "process.stdin.on(\'data\', c => process.stdout.write(c)); setTimeout(()=>{},30000)"'
    const started = yield* proc.execute({ action: "start", rootID: root.id, command, mode: "background" })
    const handle = (started.structured as { handle: string }).handle

    const written = yield* proc.execute({ action: "write", handle, chars: "hello🙂" })
    expect(written.output).toContain("wrote")
    let polled = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    for (let attempt = 0; attempt < 20 && polled.output !== "hello🙂"; attempt++) {
      yield* Effect.sleep("50 millis")
      polled = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    }
    expect(polled.output).toBe("hello🙂")
    expect(polled.structured).toMatchObject({ output: "hello🙂", offset: 0 })

    yield* proc.execute({ action: "kill", handle })
  }))

  it.live("writes continuation bytes through exact-argv process stdin too", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [
        process.execPath,
        "-e",
        "process.stdin.on('data', c => process.stdout.write(c)); setTimeout(()=>{},30000)",
      ],
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle
    const written = yield* proc.execute({ action: "write", handle, chars: "argv🙂" })
    expect(written.output).toContain("wrote 8 bytes")
    let polled = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    for (let attempt = 0; attempt < 20 && polled.output !== "argv🙂"; attempt++) {
      yield* Effect.sleep("50 millis")
      polled = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    }
    expect(polled.output).toBe("argv🙂")
    yield* proc.execute({ action: "kill", handle })
  }))

  it.live("enforces the process write limit in bytes rather than UTF-16 character count", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const command =
      JSON.stringify(process.execPath) +
      ' -e "process.stdin.resume(); setTimeout(()=>{},30000)"'
    const started = yield* proc.execute({ action: "start", rootID: root.id, command, mode: "background" })
    const handle = (started.structured as { handle: string }).handle

    const oversized = "🙂".repeat(70_000)
    expect(oversized.length).toBeLessThanOrEqual(256 * 1024)
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(256 * 1024)
    const rejected = yield* proc.execute({ action: "write", handle, chars: oversized }).pipe(Effect.flip)
    expect(rejected._tag).toBe("OXP_INVALID_ARGUMENT")
    expect(rejected.detail).toContain("256 KiB")
    yield* proc.execute({ action: "kill", handle })
  }))

  it.live("bounds backpressured stdin writes instead of hanging the request indefinitely", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"],
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle

    const blocked = yield* proc.execute({
      action: "write",
      handle,
      chars: "x".repeat(256 * 1024),
      timeoutMs: 100,
    }).pipe(Effect.flip)
    expect(blocked._tag).toBe("OXP_TIMEOUT")
    expect(blocked.metadata).toMatchObject({ ambiguous: true })
    yield* proc.execute({ action: "kill", handle })
  }), { timeout: 10_000 })



  it.live("settles exit metadata before a killed process is reported terminal", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      command: JSON.stringify(process.execPath) + ' -e "setTimeout(()=>{},30000)"',
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle

    const killed = yield* proc.execute({ action: "kill", handle })
    const state = killed.structured as {
      running?: boolean
      endedAt?: number
      exitCode?: number
      terminationReason?: string
    }
    expect(state.running).toBe(false)
    expect(state.endedAt).toBeNumber()
    expect(state.exitCode).toBeNumber()
    expect(state.terminationReason).toBe("requested-kill")
  }))

  it.live("treats POSIX signal termination as terminal even without a numeric exit code", Effect.gen(function* () {
    if (process.platform === "win32") return
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const started = yield* proc.startArgv({
      rootID: root.id,
      operation: "test.signal-terminal",
      argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"],
    })
    yield* started.process.kill({ killSignal: "SIGTERM", forceKillAfter: "3 seconds" })
    const waited = yield* proc.execute({ action: "wait", handle: started.handle, timeoutMs: 5_000 })
    const state = waited.structured as {
      running?: boolean
      endedAt?: number
      exitCode?: number
      terminationReason?: string
      terminationSignal?: string
    }
    expect(state.running).toBe(false)
    expect(state.endedAt).toBeNumber()
    expect(state.exitCode).toBeUndefined()
    expect(state.terminationReason).toBe("signal")
    expect(state.terminationSignal).toBe("SIGTERM")
  }))

  it.live("foreground request cancellation retires the spawned tree instead of stranding an undisclosed handle", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const command = JSON.stringify(process.execPath) + ' -e "setTimeout(()=>{},30000)"'
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 75)
    const cancelled = yield* proc.execute(
      { action: "start", rootID: root.id, command, mode: "foreground", yieldMs: 30_000 },
      controller.signal,
    ).pipe(Effect.flip)
    clearTimeout(timer)
    expect(cancelled._tag).toBe("OXP_CANCELLED")
    expect(cancelled.metadata).toMatchObject({ committed: true })
    const handle = String(cancelled.metadata?.handle)
    expect(handle).toMatch(/^proc_/)

    const listed = yield* proc.execute({ action: "list", rootID: root.id })
    expect((listed.structured as {
      processes: Array<{ handle: string; running: boolean; terminationReason?: string }>
    }).processes).toContainEqual(
      expect.objectContaining({
        handle,
        running: false,
        terminationReason: "request-cancelled",
      }),
    )
    yield* proc.execute({ action: "remove", handle })
  }))

  it.live("actively retires process trees when their approved root is revoked", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const command = JSON.stringify(process.execPath) + ' -e "setTimeout(()=>{},30000)"'
    const started = yield* proc.execute({ action: "start", rootID: root.id, command, mode: "background" })
    const handle = (started.structured as { handle: string }).handle

    yield* roots.remove(root.id)
    yield* Effect.sleep("150 millis")
    const stale = yield* proc.execute({ action: "status", handle }).pipe(Effect.flip)
    expect(["OXP_HANDLE_STALE", "OXP_AUTH_REVOKED", "OXP_ROOT_NOT_FOUND"]).toContain(stale._tag)
  }))

  it.live("retires long-running trees when the approved root disappears on disk without config mutation", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    const movedRoot = path.join(suite, "workspace-moved")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [
        process.execPath,
        "-e",
        "process.chdir(require('os').tmpdir()); process.stdout.write('READY'); setTimeout(()=>{},30000)",
      ],
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle
    let ready = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    for (let attempt = 0; attempt < 20 && ready.output !== "READY"; attempt++) {
      yield* Effect.sleep("50 millis")
      ready = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    }
    expect(ready.output).toBe("READY")

    yield* Effect.promise(() => fs.rename(rootDir, movedRoot))
    let state = yield* proc.execute({ action: "status", handle }).pipe(
      Effect.map(() => "running" as const),
      Effect.catch((error) => Effect.succeed(error._tag)),
    )
    for (let attempt = 0; attempt < 20 && state !== "OXP_HANDLE_STALE"; attempt++) {
      yield* Effect.sleep("250 millis")
      state = yield* proc.execute({ action: "status", handle }).pipe(
        Effect.map(() => "running" as const),
        Effect.catch((error) => Effect.succeed(error._tag)),
      )
    }
    expect(state).toBe("OXP_HANDLE_STALE")
    yield* Effect.promise(() => fs.rename(movedRoot, rootDir))
  }), { timeout: 10_000 })

  it.live("retires long-running trees when the approved root is replaced at the same path", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    const original = path.join(suite, "workspace-original")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    if (!root.identityFingerprint) return
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const started = yield* proc.execute({
      action: "start",
      rootID: root.id,
      argv: [
        process.execPath,
        "-e",
        "process.chdir(require('os').tmpdir()); process.stdout.write('READY'); setTimeout(()=>{},30000)",
      ],
      mode: "background",
    })
    const handle = (started.structured as { handle: string }).handle
    let ready = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    for (let attempt = 0; attempt < 20 && ready.output !== "READY"; attempt++) {
      yield* Effect.sleep("50 millis")
      ready = yield* proc.execute({ action: "poll", handle, offset: 0, maxBytes: 64 })
    }
    expect(ready.output).toBe("READY")
    yield* Effect.promise(() => fs.rename(rootDir, original))
    yield* Effect.promise(() => fs.mkdir(rootDir))
    let stale = yield* proc.execute({ action: "status", handle }).pipe(Effect.flip)
    for (let attempt = 0; attempt < 20 && stale._tag === "OXP_ROOT_CHANGED"; attempt++) {
      yield* Effect.sleep("250 millis")
      stale = yield* proc.execute({ action: "status", handle }).pipe(Effect.flip)
    }
    expect(stale._tag).toBe("OXP_HANDLE_STALE")
  }), { timeout: 10_000 })

  it.live("runs exact argv in the canonical nested workdir and captures output through the owned handle", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    const nested = path.join(rootDir, "nested")
    yield* Effect.promise(() => fs.mkdir(nested, { recursive: true }))
    yield* Effect.promise(() => fs.writeFile(path.join(nested, "marker.txt"), "ok"))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    let observed = ""
    const started = yield* proc.startArgv({
      rootID: root.id,
      workdir: "nested",
      operation: "test.run",
      argv: [
        process.execPath,
        "-e",
        "require('fs').accessSync('marker.txt');process.stdout.write('OXP_ARGV_CWD_OK')",
      ],
      onChunk: (chunk) => {
        observed += chunk
      },
    })
    yield* started.process.exitCode.pipe(Effect.catch(() => Effect.succeed(-1)))
    yield* Effect.sleep("25 millis")
    const polled = yield* proc.execute({ action: "poll", handle: started.handle, offset: 0, maxBytes: 1024 })
    expect(polled.output).toContain("OXP_ARGV_CWD_OK")
    expect(observed).toContain("OXP_ARGV_CWD_OK")
    expect(JSON.stringify(polled)).not.toContain(rootDir)
  }))

  it.live("strips ambient secrets from exact-argv adapter processes too", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const key = "OPENFORK_OXP_EXACT_ARGV_API_KEY"
    let observed = ""
    const started = yield* proc.startArgv({
      rootID: root.id,
      operation: "test.run",
      argv: [process.execPath, "-e", `process.stdout.write(String(Object.hasOwn(process.env, '${key}')))`],
      env: { ...process.env, [key]: "must-not-reach-child", OPENFORK_OXP_PUBLIC: "visible" },
      onChunk: (chunk) => { observed += chunk },
    })
    yield* started.process.exitCode.pipe(Effect.catch(() => Effect.succeed(-1)))
    yield* Effect.sleep("25 millis")
    expect(observed).toBe("false")
    yield* proc.execute({ action: "remove", handle: started.handle }).pipe(Effect.ignore)
  }))

  it.live("keeps exact-argv waits bounded without retiring the still-owned process", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const started = yield* proc.startArgv({
      rootID: root.id,
      operation: "test.run",
      argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"],
    })
    const waited = yield* proc.execute({ action: "wait", handle: started.handle, timeoutMs: 100 })
    expect((waited.structured as { running: boolean }).running).toBe(true)
    yield* proc.execute({ action: "kill", handle: started.handle })
  }))

  it.live("rejects an already-cancelled exact-argv request before spawning", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })
    const controller = new AbortController()
    controller.abort()

    const cancelled = yield* proc
      .startArgv(
        {
          rootID: root.id,
          operation: "test.run",
          argv: [process.execPath, "-e", "process.stdout.write('SHOULD_NOT_RUN')"],
        },
        controller.signal,
      )
      .pipe(Effect.flip)
    expect(cancelled._tag).toBe("OXP_CANCELLED")
    const listed = yield* proc.execute({ action: "list", rootID: root.id })
    expect(listed.structured).toEqual({ processes: [] })
  }))

  it.live("retires an undisclosed exact-argv child when cancellation fires inside spawn admission", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    let aborted = false
    const abortReason = new Error("mid-spawn abort")
    const signal = {
      get aborted() {
        return aborted
      },
      reason: abortReason,
      onabort: null,
      addEventListener(_type: string, listener: EventListenerOrEventListenerObject) {
        aborted = true
        const event = new Event("abort")
        if (typeof listener === "function") listener.call(this, event)
        else listener.handleEvent(event)
      },
      removeEventListener() {},
      dispatchEvent() {
        return true
      },
      throwIfAborted() {
        if (aborted) throw abortReason
      },
    } as unknown as AbortSignal

    const cancelled = yield* proc.startArgv({
      rootID: root.id,
      operation: "test.run",
      argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"],
    }, signal).pipe(Effect.flip)
    expect(cancelled._tag).toBe("OXP_CANCELLED")
    const listed = yield* proc.execute({ action: "list", rootID: root.id })
    expect(listed.structured).toEqual({ processes: [] })
  }))

  it.live("retires exact-argv children when connector identity rotates", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
    yield* config.setEnabled(true)
    yield* config.setGrant({ process: true })

    const started = yield* proc.startArgv({
      rootID: root.id,
      operation: "test.run",
      argv: [process.execPath, "-e", "setTimeout(()=>{},30000)"],
    })
    yield* config.update((current) => ({
      ...current,
      connector: {
        ...current.connector,
        id: OxpSchema.ConnectorID.make(randomUUID()),
      },
    }))
    yield* Effect.sleep("150 millis")
    const stale = yield* proc.execute({ action: "status", handle: started.handle }).pipe(Effect.flip)
    expect(["OXP_HANDLE_STALE", "OXP_AUTH_DENIED"]).toContain(stale._tag)
  }))
})
