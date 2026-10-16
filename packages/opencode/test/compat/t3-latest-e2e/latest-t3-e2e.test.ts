/**
 * REAL latest-stock-T3 -> OpenFork end-to-end harness.
 *
 * EVIDENCE CLASS for this file: real_E2E. Every gate below drives a REAL child
 * process and, where labelled, a REAL HTTP request or a REAL SSE byte stream
 * against a REAL OpenFork server. Nothing here is mocked. This is deliberately
 * kept separate from test/server/t3code-compat-contract.test.ts (contract_tests
 * only: OpenApi spec + Schema.is introspection, no process, no HTTP, no SSE).
 *
 * T3 IMMUTABILITY: T3 is never modified, never checked out, never executed from
 * its own worktree. The T3 decision logic under test is transcribed verbatim from
 * stock T3 origin/main a21702d0e in ./t3-latest-probe.ts; this file supplies the
 * real process and the real bytes.
 *
 * PIN THIS when reporting: OpenFork commit, T3 commit, and whether the
 * OPENFORK_COMPAT_PROFILE env var was active. See the two launch modes below —
 * a source-mode result must never be reported as a shipped-binary result.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { createServer as createHttpServer } from "node:http"
import { createServer } from "node:net"
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  MINIMUM_OPENCODE_VERSION,
  classifyOpenCodeCliVersion,
  classifyOpenCodeProbeResponse,
  parseGenericCliVersion,
  probeAuthorizationHeader,
  probeOpenCodeServerPaths,
  probeRequestUrl,
  verifyOpenCodeServerVersion,
} from "./t3-latest-probe"

const PACKAGE_ROOT = join(import.meta.dir, "..", "..", "..")
const SERVER_PASSWORD = "t3-latest-e2e-password-0123456789"
const SERVER_USERNAME = "opencode"
const T3_COMMIT = "a21702d0e58ad20263dc965d84472bb6d7eb38c8"

/**
 * Two launch modes, reported separately and never conflated.
 *
 * SOURCE mode runs CURRENT src/ with the compat profile activated in-process, so
 * it proves the facade as the tree stands today. SHIPPED mode execs the built
 * release executable, which is what a real T3 install would invoke, but that
 * artifact can lag the source. Both must land on v1.
 */
type LaunchMode = "source" | "shipped"
const SERVER_LAUNCH_MODE: LaunchMode = process.env.OPENFORK_T3_E2E_MODE === "shipped" ? "shipped" : "source"

function compatEnv(mode: LaunchMode): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(base)) {
    if (key.startsWith("OPENCODE_") || key.startsWith("OPENFORK_")) delete base[key]
  }
  Object.assign(base, {
    OPENFORK_COMPAT_PROFILE: "t3code-opencode-v1",
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_CONFIG_CONTENT: "{}",
  })
  if (mode === "shipped") {
    base["OPENFORK_BIN_PATH"] = process.env.OPENFORK_T3_E2E_BIN_PATH ?? join(
        PACKAGE_ROOT,
        "dist",
        "openfork-windows-x64",
        "bin",
        "openfork.exe",
      )
  }
  return base
}

function runVersionProbe(mode: LaunchMode): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child =
      mode === "source"
        ? spawn("bun", ["src/index.ts", "--version"], { cwd: PACKAGE_ROOT, env: compatEnv(mode) })
        : spawn("node", ["bin/openfork-t3code", "--version"], { cwd: PACKAGE_ROOT, env: compatEnv(mode) })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, code }))
  })
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not determine a free port")))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

function waitForListeningLine(read: () => string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const poll = () => {
      const match = read().match(/server listening on\s+(https?:\/\/[^\s]+)/i)
      if (match?.[1]) {
        resolve(match[1])
        return
      }
      if (Date.now() > deadline) {
        reject(new Error(`server did not report listening within ${timeoutMs}ms`))
        return
      }
      setTimeout(poll, 50)
    }
    poll()
  })
}

function basicAuth(): string {
  return `Basic ${Buffer.from(`${SERVER_USERNAME}:${SERVER_PASSWORD}`, "utf8").toString("base64")}`
}

interface LiveServer {
  readonly url: string
  readonly port: number
  readonly workspace: string
  stop(): Promise<void>
}

async function startServer(mode: LaunchMode, configContent = "{}"): Promise<LiveServer> {
  const port = await findFreePort()
  const dbDir = mkdtempSync(join(tmpdir(), "openfork-t3-latest-db-"))
  const workspace = join(dbDir, "workspace")
  mkdirSync(workspace, { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...compatEnv(mode),
    OPENCODE_DB: join(dbDir, "opencode.db"),
    OPENCODE_CONFIG_CONTENT: configContent,
  }
  const serveArgs = ["serve", "--hostname=127.0.0.1", `--port=${port}`]
  const child = mode === "source"
    ? spawn(process.execPath, ["src/index.ts", ...serveArgs], { cwd: PACKAGE_ROOT, env })
    : spawn(env["OPENFORK_BIN_PATH"]!, serveArgs, { cwd: PACKAGE_ROOT, env })

  let output = ""
  child.stdout?.on("data", (chunk) => (output += String(chunk)))
  child.stderr?.on("data", (chunk) => (output += String(chunk)))

  let url: string
  try {
    url = await waitForListeningLine(() => output, 90_000)
  } catch (cause) {
    child.kill("SIGKILL")
    throw new Error(`${(cause as Error).message}\n--- server output ---\n${output.slice(-4000)}`)
  }

  return {
    url,
    port,
    workspace,
    async stop() {
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()))
      child.kill("SIGTERM")
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500)),
      ])
      if (!graceful && child.exitCode === null) {
        if (process.platform === "win32" && child.pid !== undefined) {
          const taskkill = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          })
          await new Promise<void>((resolve) => {
            taskkill.once("error", () => resolve())
            taskkill.once("close", () => resolve())
          })
        } else {
          child.kill("SIGKILL")
        }
      }
      await exited
    },
  }
}

interface ProbeResult {
  readonly status: number
  readonly contentType: string | undefined
  readonly body: string
}

async function probe(server: LiveServer, path: string, withAuth: boolean): Promise<ProbeResult> {
  const response = await fetch(`${server.url}${path}`, {
    headers: withAuth ? { authorization: basicAuth() } : {},
  })
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    body: await response.text(),
  }
}

async function json<T>(server: LiveServer, path: string, init?: RequestInit): Promise<{ status: number; value: T }> {
  const method = (init?.method ?? "GET").toUpperCase()
  const url = new URL(path, server.url)
  const headers: Record<string, string> = {
    authorization: basicAuth(),
    "content-type": "application/json",
    ...(init?.headers as Record<string, string> | undefined),
  }
  // Match the pinned @opencode-ai/sdk 1.x location interceptor: reads carry
  // directory as a query parameter; writes carry the encoded legacy header.
  // Without this, instance routes fail closed and the harness tests an
  // impossible T3 request rather than a compatibility regression.
  if (method === "GET" || method === "HEAD") url.searchParams.set("directory", server.workspace)
  else headers["x-opencode-directory"] = encodeURIComponent(server.workspace)
  const response = await fetch(url, {
    ...init,
    headers,
  })
  const text = await response.text()
  let value: T
  try {
    value = JSON.parse(text) as T
  } catch {
    value = undefined as T
  }
  return { status: response.status, value }
}

async function openLegacyEventStream(server: LiveServer, directory: string) {
  const url = new URL("/event", server.url)
  url.searchParams.set("directory", directory)
  const controller = new AbortController()
  const response = await fetch(url, {
    headers: { authorization: basicAuth(), accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (!response.ok || !response.body) throw new Error(`T3 event stream failed: HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  return {
    async waitForType(type: string, timeoutMs: number) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        let timer: ReturnType<typeof setTimeout> | undefined
        const remaining = deadline - Date.now()
        const next = await Promise.race([
          reader.read().finally(() => timer && clearTimeout(timer)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type} on T3 /event`)), remaining)
          }),
        ])
        if (next.done) throw new Error(`T3 event stream ended while waiting for ${type}`)
        buffer += decoder.decode(next.value, { stream: true })
        while (true) {
          const boundary = buffer.indexOf("\n\n")
          if (boundary < 0) break
          const record = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = record.split(/\r?\n/).find((line) => line.startsWith("data: "))?.slice(6)
          if (!data) continue
          const event = JSON.parse(data) as { type?: string; properties?: unknown }
          if (event.type === type) return event
        }
      }
      throw new Error(`Timed out waiting for ${type} on T3 /event`)
    },
    async close() {
      controller.abort()
      await reader.cancel().catch(() => undefined)
    },
  }
}

describe(`stock latest T3 ${T3_COMMIT} -> OpenFork REAL E2E`, () => {
  let server: LiveServer

  beforeAll(async () => {
    server = await startServer(SERVER_LAUNCH_MODE)
  }, 180_000)

  afterAll(async () => {
    await server?.stop()
  })

  describe("permission rejection (real listener and deterministic provider)", () => {
    // This gate drives OpenFork's real legacy HTTP surface with the same request
    // shapes stock T3 sends. The separate immutable T3 runtime/UI checks remain
    // the evidence for adapter and presentation behavior.
    test("reply=reject denies the tool, and abort closes an active provider request", async () => {
      const providerPort = await findFreePort()
      let resolveCancellationStarted!: () => void
      let resolveCancellationClosed!: () => void
      const cancellationStarted = new Promise<void>((resolve) => (resolveCancellationStarted = resolve))
      const cancellationClosed = new Promise<void>((resolve) => (resolveCancellationClosed = resolve))
      const fakeProvider = createHttpServer(async (request, response) => {
        const chunks: Uint8Array[] = []
        for await (const chunk of request) chunks.push(chunk)
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          tools?: Array<{ function?: { name?: string }; name?: string }>
          messages?: Array<{ role?: string; content?: unknown }>
        }
        if (JSON.stringify(payload.messages ?? []).includes("T3_CANCEL_ACTIVE_PROVIDER")) {
          response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
          response.write(`data: ${JSON.stringify({ id: "chatcmpl-t3-cancel", object: "chat.completion.chunk", created: 1, model: "t3-test-model", choices: [{ index: 0, delta: { content: "provider stream started" }, finish_reason: null }] })}\n\n`)
          response.once("close", resolveCancellationClosed)
          resolveCancellationStarted()
          return
        }
        const toolNames = (payload.tools ?? []).map((tool) => tool.function?.name ?? tool.name)
        const toolResults = (payload.messages ?? []).filter((message) => message.role === "tool")
        let delta: Record<string, unknown>
        if (toolResults.length) {
          delta = { content: "T3_REJECTION_RECOVERED" }
        } else if (toolNames.includes("generated_title")) {
          delta = {
            tool_calls: [{
              index: 0,
              id: "call_t3_reject_title",
              type: "function",
              function: { name: "generated_title", arguments: JSON.stringify({ title: "T3 reject E2E" }) },
            }],
          }
        } else if (toolNames.includes("bash")) {
          delta = {
            tool_calls: [{
              index: 0,
              id: "call_t3_reject_bash",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "echo T3_REJECTED_COMMAND_RAN" }) },
            }],
          }
        } else {
          delta = { content: "unexpected provider request" }
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-t3-reject", object: "chat.completion.chunk", created: 1, model: "t3-test-model", choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? "tool_calls" : null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: "chatcmpl-t3-reject", object: "chat.completion.chunk", created: 1, model: "t3-test-model", choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? "tool_calls" : "stop" }] })}\n\n`)
        response.end("data: [DONE]\n\n")
      })
      await new Promise<void>((resolve) => fakeProvider.listen(providerPort, "127.0.0.1", resolve))

      const configContent = JSON.stringify({
        formatter: false,
        lsp: false,
        permission: { bash: "ask" },
        provider: {
          test: {
            name: "Test",
            id: "test",
            env: [],
            npm: "@ai-sdk/openai-compatible",
            models: {
              "t3-test-model": {
                id: "t3-test-model",
                name: "T3 test model",
                attachment: false,
                reasoning: false,
                temperature: false,
                tool_call: true,
                release_date: "2025-01-01",
                limit: { context: 100_000, output: 10_000 },
                cost: { input: 0, output: 0 },
                options: {},
              },
            },
            options: { apiKey: "t3-test-key", baseURL: `http://127.0.0.1:${providerPort}/v1` },
          },
        },
      })

      const active = await startServer(SERVER_LAUNCH_MODE, configContent)
      const eventDirectory = join(active.workspace, "..", "workspace-event-alias")
      symlinkSync(active.workspace, eventDirectory, process.platform === "win32" ? "junction" : "dir")
      let eventStream: Awaited<ReturnType<typeof openLegacyEventStream>> | undefined
      try {
        // Simulate T3 retaining a short Windows path or opening a workspace
        // through a junction. The event producer publishes its canonical
        // instance location, while the SDK sends the selected directory.
        eventStream = await openLegacyEventStream(active, eventDirectory)
        const created = await json<{ id: string }>(active, "/session", {
          method: "POST",
          body: JSON.stringify({ title: "T3 permission rejection" }),
        })
        expect(created.status).toBe(200)
        const sessionID = created.value.id
        const prompted = await json<unknown>(active, `/session/${sessionID}/prompt_async`, {
          method: "POST",
          body: JSON.stringify({
            model: { providerID: "test", modelID: "t3-test-model" },
            agent: "build",
            parts: [{ type: "text", text: "Run the requested shell command." }],
          }),
        })
        expect(prompted.status).toBeGreaterThanOrEqual(200)
        expect(prompted.status).toBeLessThan(300)

        let pending: Array<{ id: string; permission: string }> = []
        for (let attempt = 0; attempt < 120; attempt++) {
          const result = await json<Array<{ id: string; permission: string }>>(active, "/permission")
          expect(result.status).toBe(200)
          pending = result.value
          if (pending.length > 0) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        expect(pending).toHaveLength(1)
        expect(pending[0]?.permission).toBe("bash")
        const permissionEvent = (await eventStream.waitForType("permission.asked", 5_000)) as {
          properties?: { id?: string; permission?: string }
        }
        expect(permissionEvent.properties?.id).toBe(pending[0]?.id)
        expect(permissionEvent.properties?.permission).toBe("bash")

        const reply = await json<boolean>(active, `/permission/${pending[0]!.id}/reply`, {
          method: "POST",
          body: JSON.stringify({ reply: "reject" }),
        })
        expect(reply.status).toBe(200)
        expect(reply.value).toBe(true)

        let messages: Array<{ info: { role: string; time?: { completed?: number } }; parts: Array<{ type: string; state?: { status?: string; error?: string; input?: { command?: string }; output?: string; time?: { end?: number } } }> }> = []
        for (let attempt = 0; attempt < 120; attempt++) {
          const result = await json<typeof messages>(active, `/session/${sessionID}/message`)
          expect(result.status).toBe(200)
          messages = result.value
          if (messages.some((message) => message.parts.some((part) => part.type === "tool" && part.state?.status === "error"))) break
          await new Promise((resolve) => setTimeout(resolve, 250))
        }
        const assistant = messages.find((message) => message.info.role === "assistant")
        const rejectedTool = assistant?.parts.find((part) => part.type === "tool" && part.state?.status === "error")
        expect(rejectedTool?.state?.error?.toLowerCase()).toContain("rejected permission")
        expect(rejectedTool?.state?.time?.end).toBeDefined()
        expect(rejectedTool?.state?.input?.command).toBe("echo T3_REJECTED_COMMAND_RAN")
        expect(rejectedTool?.state?.output ?? "").not.toContain("T3_REJECTED_COMMAND_RAN")

        const remaining = await json<unknown[]>(active, "/permission")
        expect(remaining.value).toEqual([])

        const activeTurn = await json<{ id: string }>(active, "/session", {
          method: "POST",
          body: JSON.stringify({ title: "T3 active cancellation" }),
        })
        const cancellationPrompt = await json<unknown>(active, `/session/${activeTurn.value.id}/prompt_async`, {
          method: "POST",
          body: JSON.stringify({
            model: { providerID: "test", modelID: "t3-test-model" },
            agent: "build",
            parts: [{ type: "text", text: "T3_CANCEL_ACTIVE_PROVIDER" }],
          }),
        })
        expect(cancellationPrompt.status).toBeGreaterThanOrEqual(200)
        expect(cancellationPrompt.status).toBeLessThan(300)
        await Promise.race([
          cancellationStarted,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("provider request did not start")), 10_000)),
        ])
        const aborted = await json<boolean>(active, `/session/${activeTurn.value.id}/abort`, { method: "POST" })
        expect(aborted.status).toBe(200)
        expect(aborted.value).toBe(true)
        const providerStreamClosed = await Promise.race([
          cancellationClosed.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10_000)),
        ])
        expect(providerStreamClosed).toBe(true)
      } finally {
        await eventStream?.close()
        await active.stop()
        await new Promise<void>((resolve) => fakeProvider.close(() => resolve()))
      }
    }, 120_000)
  })

  // ---------------------------------------------------------------------
  // GATE 1 — LOCAL BINARY probe. T3 runs `<binaryPath> --version`.
  // ---------------------------------------------------------------------
  describe("GATE 1 local binary version probe (real subprocess)", () => {
    test("source mode: --version stdout is EXACTLY 1.15.13 and classifies v1", async () => {
      const { stdout, stderr, code } = await runVersionProbe("source")
      const trimmed = stdout.trim()
      if (code !== 0) {
        throw new Error(`probe exited ${code}: ${stderr || stdout}`)
      }
      // Exact, not "contains": a stray stdout log line would change the parse.
      expect(trimmed).toBe("1.15.13")
      expect(parseGenericCliVersion(stdout)).toBe("1.15.13")
      const classified = classifyOpenCodeCliVersion(stdout)
      expect(classified).toEqual({ generation: "v1", version: "1.15.13" })
    }, 120_000)

    test("shipped binary mode: same assertion against the built release executable", async () => {
      const { stdout, code } = await runVersionProbe("shipped")
      if (code !== 0) {
        // The shipped artifact is optional in a source checkout; record why
        // rather than reporting a green that never ran.
        throw new Error(`shipped probe exited ${code}: ${stdout}`)
      }
      expect(stdout.trim()).toBe("1.15.13")
      expect(classifyOpenCodeCliVersion(stdout)).toEqual({ generation: "v1", version: "1.15.13" })
    }, 120_000)
  })

  // ---------------------------------------------------------------------
  // GATE 2 — EXTERNAL serverUrl probe. Real HTTP against the real server.
  // ---------------------------------------------------------------------
  describe("GATE 2 external serverUrl probe (real HTTP)", () => {
    test("/api/info MUST NOT identify as v2 — this is what keeps latest T3 on v1", async () => {
      const result = await probe(server, "/api/info", true)
      // The invariant is the 200 + application/json + {version,pid} TRIPLE, not
      // the status alone. Assert the classifier's verdict directly so a future
      // 200-JSON /api/info fails here loudly instead of flipping the facade.
      const verdict = classifyOpenCodeProbeResponse("/api/info", result)
      expect(verdict).toBeUndefined()
      if (result.status === 200) {
        expect(result.contentType?.split(";")[0]?.trim().toLowerCase()).not.toBe("application/json")
      }
    })

    test("/global/health answers 200 application/json {healthy:true,version} and classifies v1", async () => {
      const result = await probe(server, "/global/health", true)
      expect(result.status).toBe(200)
      expect(result.contentType?.split(";")[0]?.trim().toLowerCase()).toBe("application/json")
      expect(JSON.parse(result.body)).toEqual({ healthy: true, version: "1.15.13" })
      expect(classifyOpenCodeProbeResponse("/global/health", result)).toEqual({
        generation: "v1",
        version: "1.15.13",
      })
    })

    test("the probed version clears T3's own minimum-version gate", async () => {
      expect(verifyOpenCodeServerVersion("1.15.13")).toEqual({ ok: true })
      expect(verifyOpenCodeServerVersion(MINIMUM_OPENCODE_VERSION)).toEqual({ ok: true })
    })

    test("the facade version stays inside the dual-generation window [1.14.19, 2.0.0)", async () => {
      // The real regression is ESCAPING this band: >=2.0.0 is "broken" for old T3
      // and "unsupported" for latest T3; <1.14.19 is broken for both. Asserting
      // equality to 1.15.13 alone would miss a future bump.
      const result = await probe(server, "/global/health", true)
      const reported = (JSON.parse(result.body) as { version: string }).version
      const major = Number(reported.split(".")[0])
      expect(major).toBeGreaterThanOrEqual(1)
      expect(major).toBeLessThan(2)
      expect(verifyOpenCodeServerVersion(reported).ok).toBe(true)
    })

    test("no credentials is rejected (401) and 401 says nothing about generation", async () => {
      const result = await probe(server, "/global/health", false)
      expect(result.status).toBe(401)
      // T3 short-circuits on 401 rather than inferring a version from it.
      expect(classifyOpenCodeProbeResponse("/global/health", result)).toBe("unauthorized")
    })
  })

  // ---------------------------------------------------------------------
  // GATE 3 — CATALOG. Real HTTP against the v1 SDK operation surface.
  // ---------------------------------------------------------------------
  describe("GATE 3 v1 catalog surface (real HTTP)", () => {
    test("provider.list answers a v1 envelope with all/connected", async () => {
      const { status, value } = await json<{ all?: unknown[]; default?: unknown; connected?: unknown[] }>(
        server,
        "/provider",
      )
      expect(status).toBe(200)
      expect(Array.isArray(value.all)).toBe(true)
      expect(Array.isArray(value.connected)).toBe(true)
    })

    test("app.agents / app.skills / command.list all answer 200 JSON arrays", async () => {
      for (const path of ["/agent", "/skill", "/command"]) {
        const { status, value } = await json<unknown[]>(server, path)
        expect(status).toBe(200)
        expect(Array.isArray(value)).toBe(true)
      }
    })

    test("session.status is bootstrap-free: valid unscoped, returns a session-id map", async () => {
      const { status, value } = await json<Record<string, unknown>>(server, "/session/status")
      expect(status).toBe(200)
      expect(typeof value).toBe("object")
      expect(value).not.toBeNull()
    })
  })

  // ---------------------------------------------------------------------
  // GATE 4 — SESSION + LATEST-T3 PERMISSION RULESET ACCEPTANCE.
  // ---------------------------------------------------------------------
  describe("GATE 4 session lifecycle and latest-T3 permission payload (real HTTP)", () => {
    /**
     * Transcribed from stock T3 origin/main opencodeRuntime.ts
     * `buildOpenCodePermissionRules` for the supervised ("ask") mode. This is
     * the exact array latest T3 sends. `codesearch` and `doom_loop` are NEW in
     * latest T3 relative to the audited old-T3 contract — if the legacy ruleset
     * schema rejected unknown names, every latest-T3 supervised session would
     * fail here while old T3 stayed green.
     */
    const latestT3SupervisedRules = [
      { permission: "*", pattern: "*", action: "ask" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*.env", action: "ask" },
      { permission: "read", pattern: "*.env.*", action: "ask" },
      { permission: "read", pattern: "*.env.example", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "lsp", pattern: "*", action: "allow" },
      { permission: "skill", pattern: "*", action: "allow" },
      { permission: "todowrite", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "edit", pattern: "*", action: "ask" },
      { permission: "webfetch", pattern: "*", action: "ask" },
      { permission: "websearch", pattern: "*", action: "ask" },
      { permission: "codesearch", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "*", action: "ask" },
      { permission: "doom_loop", pattern: "*", action: "ask" },
      { permission: "question", pattern: "*", action: "allow" },
    ]

    let sessionID: string

    test("session.create returns a session id", async () => {
      const { status, value } = await json<{ id?: string; info?: { id?: string } }>(server, "/session", {
        method: "POST",
        body: JSON.stringify({}),
      })
      expect(status).toBe(200)
      const id = value?.id ?? value?.info?.id
      expect(typeof id).toBe("string")
      sessionID = id as string
    })

    test("session.get round-trips that session", async () => {
      const { status } = await json<unknown>(server, `/session/${sessionID}`)
      expect(status).toBe(200)
    })

    test("session.update ACCEPTS the latest-T3 ruleset including codesearch and doom_loop", async () => {
      const { status } = await json<unknown>(server, `/session/${sessionID}`, {
        method: "PATCH",
        body: JSON.stringify({ permission: latestT3SupervisedRules }),
      })
      // Non-2xx here is the concrete latest-T3 v1 incompatibility this gate exists
      // to catch: it would break supervised and auto-accept-edits sessions only.
      expect(status).toBeGreaterThanOrEqual(200)
      expect(status).toBeLessThan(300)
    })

    test("session.messages returns a list for the session", async () => {
      const { status, value } = await json<unknown[]>(server, `/session/${sessionID}/message`)
      expect(status).toBe(200)
      expect(Array.isArray(value)).toBe(true)
    })

    test("session.children is callable for the session", async () => {
      const { status } = await json<unknown>(server, `/session/${sessionID}/children`)
      expect(status).toBe(200)
    })

    test("session.abort terminates cleanly (TERMINATION gate)", async () => {
      const { status } = await json<unknown>(server, `/session/${sessionID}/abort`, { method: "POST" })
      expect(status).toBeGreaterThanOrEqual(200)
      expect(status).toBeLessThan(300)
    })
  })

  // ---------------------------------------------------------------------
  // GATE 5 — STREAMING. Real SSE bytes off a real socket.
  // ---------------------------------------------------------------------
  describe("GATE 5 legacy SSE stream (real bytes)", () => {
    test("GET /event is a text/event-stream that opens with server.connected", async () => {
      const controller = new AbortController()
      try {
        const eventUrl = new URL("/event", server.url)
        eventUrl.searchParams.set("directory", server.workspace)
        const response = await fetch(eventUrl, {
          headers: { authorization: basicAuth(), accept: "text/event-stream" },
          signal: controller.signal,
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()).toBe(
          "text/event-stream",
        )
        // These headers are what stop an intermediary buffering the stream into
        // the stall T3 would otherwise read as a dead session.
        expect(response.headers.get("cache-control")).toContain("no-transform")
        expect(response.headers.get("x-accel-buffering")).toBe("no")

        const body = response.body
        expect(body).not.toBeNull()
        const reader = body!.getReader()
        const decoder = new TextDecoder()
        let buffered = ""
        const deadline = Date.now() + 30_000
        let sawConnected = false

        while (Date.now() < deadline && !sawConnected) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffered += decoder.decode(chunk.value, { stream: true })
          if (buffered.includes("server.connected")) sawConnected = true
        }

        expect(sawConnected).toBe(true)
        expect(buffered).toContain("data:")
        // The pinned SDK parser consumes JSON data frames and treats omitted
        // event names as the default SSE message event; Effect's encoder
        // correctly omits `event: message` on the wire.
        const payload = buffered.match(/^data:\s*(.+)$/m)?.[1]
        expect(payload).toBeDefined()
        expect(JSON.parse(payload!).type).toBe("server.connected")
      } finally {
        controller.abort()
      }
    }, 60_000)

    test("GET /event without credentials is 401 and does not leak a stream", async () => {
      const controller = new AbortController()
      try {
        const response = await fetch(`${server.url}/event`, {
          headers: { accept: "text/event-stream" },
          signal: controller.signal,
        })
        expect(response.status).toBe(401)
      } finally {
        controller.abort()
      }
    }, 30_000)

    test("reconnect after replay grace emits a gap for the expired SDK cursor", async () => {
      const eventUrl = new URL("/event", server.url)
      eventUrl.searchParams.set("directory", server.workspace)
      const firstController = new AbortController()
      const first = await fetch(eventUrl, {
        headers: {
          authorization: basicAuth(),
          accept: "text/event-stream",
          "x-opencode-directory": encodeURIComponent(server.workspace),
        },
        signal: firstController.signal,
      })
      expect(first.status).toBe(200)
      const firstReader = first.body!.getReader()
      const decoder = new TextDecoder()
      let firstBuffer = ""
      let cursor: string | undefined
      const firstDeadline = Date.now() + 30_000
      try {
        while (Date.now() < firstDeadline && cursor === undefined) {
          const chunk = await firstReader.read()
          if (chunk.done) break
          firstBuffer += decoder.decode(chunk.value, { stream: true })
          const record = firstBuffer.split("\n\n")[0]
          if (!record) continue
          const data = record.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim()
          const id = record.split("\n").find((line) => line.startsWith("id:"))?.slice(3).trim()
          if (data && JSON.parse(data).type === "server.connected") cursor = id
          if (!cursor) firstBuffer = firstBuffer.slice(record.length + 2)
        }
      } finally {
        firstController.abort()
        await firstReader.cancel().catch(() => undefined)
      }
      expect(cursor).toBeDefined()

      await new Promise((resolve) => setTimeout(resolve, 30_100))

      const reconnectController = new AbortController()
      eventUrl.searchParams.set("directory", server.workspace)
      const reconnect = await fetch(eventUrl, {
        headers: {
          authorization: basicAuth(),
          accept: "text/event-stream",
          "x-opencode-directory": encodeURIComponent(server.workspace),
          "last-event-id": cursor!,
        },
        signal: reconnectController.signal,
      })
      expect(reconnect.status).toBe(200)
      const reader = reconnect.body!.getReader()
      let buffer = ""
      let sawGap = false
      const replayTypes: string[] = []
      const deadline = Date.now() + 30_000
      try {
        while (Date.now() < deadline && !sawGap) {
          const chunk = await reader.read()
          if (chunk.done) break
          buffer = (buffer + new TextDecoder().decode(chunk.value, { stream: true })).replace(/\r\n/g, "\n")
          const records = buffer.split("\n\n")
          buffer = records.pop() ?? ""
          for (const record of records) {
            const data = record.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim()
            if (!data) continue
            const frame = JSON.parse(data) as { type?: string }
            replayTypes.push(frame.type ?? "<untyped>")
            if (frame.type === "server.stream.gap") sawGap = true
          }
        }
      } finally {
        reconnectController.abort()
        await reader.cancel().catch(() => undefined)
      }
      expect(sawGap, `cursor=${cursor}, received=${replayTypes.join(",")}`).toBe(true)
    }, 60_000)
  })
})
// ---------------------------------------------------------------------------
// ORACLE — evidence class: contract_tests, NOT real_E2E.
//
// Pure-function fixtures over the transcribed T3 classifier. They earn their
// place by proving the generation oracle is VERSION-DRIVEN: a harness that only
// asserted "/api/info is 404 therefore v1" would be asserting a proxy fact and
// would keep passing even if the real classifier were driven by the path rather
// than the version. These fixtures pin the actual decision rule so the E2E
// negative invariant above can be read correctly.
// ---------------------------------------------------------------------------
describe("T3 generation oracle is version-driven (contract_tests only)", () => {
  const json = "application/json; charset=utf-8"

  test("a 1.x /api/info body classifies v1, proving the path alone is not the signal", () => {
    expect(
      classifyOpenCodeProbeResponse("/api/info", {
        status: 200,
        contentType: json,
        body: JSON.stringify({ version: "1.15.13", pid: 4242 }),
      }),
    ).toEqual({ generation: "v1", version: "1.15.13" })
  })

  test("a 2.x /api/info body classifies v2 — the true flip condition", () => {
    expect(
      classifyOpenCodeProbeResponse("/api/info", {
        status: 200,
        contentType: json,
        body: JSON.stringify({ version: "2.0.18", pid: 4242 }),
      }),
    ).toEqual({ generation: "v2", version: "2.0.18" })
  })

  test("a 2.x /global/health body also classifies v2", () => {
    expect(
      classifyOpenCodeProbeResponse("/global/health", {
        status: 200,
        contentType: json,
        body: JSON.stringify({ healthy: true, version: "2.0.18" }),
      }),
    ).toEqual({ generation: "v2", version: "2.0.18" })
  })

 test("404 on /api/info identifies nothing on THAT path — the loop is what advances", () => {
  expect(
  classifyOpenCodeProbeResponse("/api/info", {
  status: 404,
 contentType: json,
 body: JSON.stringify({ error: "Not Found" }),
 }),
 ).toBeUndefined()
})

 test("the LOOP, not the per-path classifier, is what carries a 404 /api/info to v1", () => {
  // The per-path classifier above structurally cannot express a fall-through:
  // it has no loop and no next path. This is the assertion that actually pins
  // OpenFork's v1 negotiation, because /api/info is a 404 and the v1 verdict is
  // produced by /global/health.
  expect(
  probeOpenCodeServerPaths({
  "/api/info": { status: 404, contentType: json, body: JSON.stringify({ error: "Not Found" }) },
  "/global/health": {
   status: 200,
   contentType: json,
   body: JSON.stringify({ healthy: true, version: "1.15.13" }),
  },
  }),
  ).toEqual({
  kind: "identified",
  probed: { generation: "v1", version: "1.15.13" },
  path: "/global/health",
  })
 })

 test("a 401 stops the loop instead of falling through to /global/health", () => {
  expect(
  probeOpenCodeServerPaths({
  "/api/info": { status: 401, contentType: undefined, body: "" },
  "/global/health": {
   status: 200,
   contentType: json,
   body: JSON.stringify({ healthy: true, version: "1.15.13" }),
  },
  }),
  ).toEqual({ kind: "unauthorized" })
 })

 test("neither candidate identifying leaves the server unidentified, not v1", () => {
  expect(
  probeOpenCodeServerPaths({
  "/api/info": { status: 404, contentType: json, body: JSON.stringify({ error: "Not Found" }) },
  "/global/health": { status: 404, contentType: json, body: JSON.stringify({ error: "Not Found" }) },
  }),
  ).toEqual({ kind: "unidentified" })
 })

 test("the probe preserves a configured URL's path prefix and query", () => {
  // fact_5: sub-path / reverse-proxy mounts are in scope for real deployments.
  expect(probeRequestUrl("http://127.0.0.1:4096/base/?x=1", "/api/info")).toBe(
  "http://127.0.0.1:4096/base/api/info?x=1",
  )
  expect(probeRequestUrl("http://127.0.0.1:4096", "/global/health")).toBe(
  "http://127.0.0.1:4096/global/health",
  )
 })

 test("probe auth is UTF-8 Basic and is omitted entirely when the password is empty", () => {
  expect(probeAuthorizationHeader("secret")).toBe(
  `Basic ${Buffer.from("opencode:secret", "utf8").toString("base64")}`,
  )
  expect(probeAuthorizationHeader("")).toBeUndefined()
  // Non-ASCII must round-trip as UTF-8, matching ServerAuth.header's default encoding.
  const nonAscii = "pässwörd-✓"
  expect(probeAuthorizationHeader(nonAscii)).toBe(
  `Basic ${Buffer.from(`opencode:${nonAscii}`, "utf8").toString("base64")}`,
  )
  expect(Buffer.from(probeAuthorizationHeader(nonAscii)!.split(" ")[1]!, "base64").toString("utf8")).toBe(
  `opencode:${nonAscii}`,
  )
 })

  test("200 without application/json falls through (HTML web UI on the other path)", () => {
    expect(
      classifyOpenCodeProbeResponse("/api/info", {
        status: 200,
        contentType: "text/html",
        body: "<html></html>",
      }),
    ).toBeUndefined()
  })

  test("a 200 JSON body missing `pid` is rejected — T3 requires both fields", () => {
    expect(
      classifyOpenCodeProbeResponse("/api/info", {
        status: 200,
        contentType: json,
        body: JSON.stringify({ version: "2.0.18" }),
      }),
    ).toBeUndefined()
  })

  test("healthy must be literally true", () => {
    expect(
      classifyOpenCodeProbeResponse("/global/health", {
        status: 200,
        contentType: json,
        body: JSON.stringify({ healthy: false, version: "2.0.18" }),
      }),
    ).toBeUndefined()
  })

  test("401 short-circuits as unauthorized and must not fall through", () => {
    expect(
      classifyOpenCodeProbeResponse("/api/info", { status: 401, contentType: undefined, body: "" }),
    ).toBe("unauthorized")
  })

  test("CLI probe: bare 1.x and `opencode v2.x` spellings both parse", () => {
    expect(classifyOpenCodeCliVersion("1.18.32\n")).toEqual({ generation: "v1", version: "1.18.32" })
    expect(classifyOpenCodeCliVersion("opencode v2.0.18\n")).toEqual({
      generation: "v2",
      version: "2.0.18",
    })
    expect(classifyOpenCodeCliVersion("")).toBeUndefined()
  })
})
