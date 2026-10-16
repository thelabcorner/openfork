#!/usr/bin/env bun
/**
 * Non-destructive source-mode ACP acceptance against a dedicated temporary DB.
 * Exercises the REAL CLI server, routes and Project.fromDirectory, not a mock
 * ACP service. This does not replace the compiled-Windows installer gate.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dir, "..")
const folder = await mkdtemp(join(tmpdir(), "openfork-acp-async-acceptance-"))
const database = join(folder, "acp.sqlite")
const cwd = process.argv[2] ? resolve(process.argv[2]) : root
const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_DB: database, OPENFORK_SQLITE_ASYNC_WORKER: "1", OPENCODE_DISABLE_CHANNEL_DB: "1" }
delete env.OPENCODE_INSTANCE_ID
const child = Bun.spawn(["bun", "run", "src/index.ts", "acp"], {
  cwd: root, env, stdin: "pipe", stdout: "pipe", stderr: "pipe",
})
const errorLog = new Response(child.stderr).text()
const reader = child.stdout.getReader()
const decoder = new TextDecoder()
let buffer = ""
const nextLine = async () => {
  for (;;) {
    const pos = buffer.indexOf("\n")
    if (pos >= 0) {
      const result = buffer.slice(0, pos).trim()
      buffer = buffer.slice(pos + 1)
      if (result) return result
      continue
    }
    const chunk = await reader.read()
    if (chunk.done) return buffer.trim() || undefined
    buffer += decoder.decode(chunk.value, { stream: true })
  }
}
const send = async (id: number, method: string, params: unknown) => {
  const request = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
  const written = child.stdin.write(request)
  if (typeof written !== "number") await written
  for (;;) {
    const raw = await nextLine()
    if (!raw) throw new Error(`ACP closed before ${method}: ${(await errorLog).slice(-2500)}`)
    let response: any
    try { response = JSON.parse(raw) } catch { throw new Error(`ACP wrote non-JSON stdout: ${raw.slice(0, 200)}`) }
    if (response?.id !== id) continue
    if (response.error) throw new Error(`ACP ${method}: ${JSON.stringify(response.error).slice(0, 2000)}`)
    return response.result
  }
}
const start = performance.now()
const run = async () => {
  const initialized = await send(1, "initialize", {
    protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "openfork-async-sqlite-test", version: "1" },
  })
  if (initialized?.protocolVersion !== 1) throw new Error("ACP protocol negotiation failed")
  const created = await send(2, "session/new", { cwd, mcpServers: [] })
  if (typeof created?.sessionId !== "string") throw new Error("ACP did not create a session ID")
  await send(3, "session/close", { sessionId: created.sessionId })
  child.stdin.end()
  for (;;) {
    const raw = await nextLine()
    if (!raw) break
    try { JSON.parse(raw) }
    catch { throw new Error(`ACP emitted non-JSON trailing stdout: ${raw.slice(0, 200)}`) }
  }
  const code = await child.exited
  if (code !== 0) throw new Error(`ACP exited ${code}: ${(await errorLog).slice(-2500)}`)
  console.log(JSON.stringify({ ok: true, cwd, elapsedMs: Math.round(performance.now() - start), worker: true }))
}
let timer: ReturnType<typeof setTimeout> | undefined
try {
  await Promise.race([
    run(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => { child.kill(); reject(new Error("ACP worker acceptance timed out")) }, 90_000)
    }),
  ])
} finally {
  if (timer) clearTimeout(timer)
  if (child.exitCode === null) child.kill()
  await rm(folder, { recursive: true, force: true })
}