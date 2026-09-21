import { afterAll, beforeEach, describe, expect } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { Effect } from "effect"
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

beforeEach(async () => {
  await fs.rm(suite, { recursive: true, force: true })
  await fs.mkdir(configDir, { recursive: true })
  await fs.mkdir(stateDir, { recursive: true })
})
afterAll(async () => fs.rm(suite, { recursive: true, force: true }))

describe("OxpProcess", () => {
  it.live("runs a foreground process without manufacturing a Session or exposing native root paths", Effect.gen(function* () {
    const config = yield* OxpConfig.Service
    const roots = yield* OxpRoot.Service
    const proc = yield* OxpProcess.Service
    const rootDir = path.join(suite, "workspace")
    yield* Effect.promise(() => fs.mkdir(rootDir))
    const root = yield* roots.approve(rootDir)
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
    expect(JSON.stringify(result)).not.toContain(rootDir)
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

    const denied = yield* proc.execute({ action: "list" }).pipe(Effect.flip)
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

    const listed = yield* proc.execute({ action: "list", rootID: root.id })
    expect(listed.structured).toEqual({ processes: [] })
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
