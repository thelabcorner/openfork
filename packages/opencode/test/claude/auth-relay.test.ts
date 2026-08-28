import { describe, test, expect } from "bun:test"
import {
  interpretAuthStatus,
  extractJsonPayload,
  extractAuthorizeUrl,
  looksLikeInvalidCodeNotice,
  firstMeaningfulLine,
  stripAnsi,
  CliLoginRelay,
  installCli,
} from "../../src/claude/auth"
import type { ClaudeProcessPort, ExecResult, SpawnHandle, StreamChunk } from "../../src/claude/process"

describe("interpretAuthStatus", () => {
  test("invalid payloads are logged out", () => {
    expect(interpretAuthStatus(null).loggedIn).toBe(false)
    expect(interpretAuthStatus("nope").detail).toBe("invalid-auth-status")
    expect(interpretAuthStatus({}).loggedIn).toBe(false)
  })

  test("api-key and console methods never count as subscription login", () => {
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "api_key" }).detail).toBe("api-key-only")
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "Console Admin" }).loggedIn).toBe(false)
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "none" }).loggedIn).toBe(false)
  })

  test("oauth/subscription methods are logged in with stable detail", () => {
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "oauth" })).toMatchObject({ loggedIn: true, detail: "auth-status-oauth" })
    expect(interpretAuthStatus({ loggedIn: true, authMethod: "Claude Subscription" })).toMatchObject({ loggedIn: true, detail: "auth-status-oauth" })
    expect(interpretAuthStatus({ loggedIn: true })).toMatchObject({ loggedIn: false, detail: "api-key-only" })
  })
})

describe("extractJsonPayload", () => {
  test("parses direct JSON, embedded JSON, and rejects garbage", () => {
    expect(extractJsonPayload('{"loggedIn":true}')).toEqual({ loggedIn: true })
    expect(extractJsonPayload("banner text\n{\"loggedIn\":false}\ntrailer")).toEqual({ loggedIn: false })
    expect(extractJsonPayload("")).toBeUndefined()
    expect(extractJsonPayload("not json { broken")).toBeUndefined()
  })
})

describe("authorize URL extraction", () => {
  test("strips ANSI, trims trailing punctuation, prefers oauth URLs, last wins", () => {
    const ansi = "\u001B[1mOpening browser...\u001B[0m\nVisit: https://claude.com/oauth/authorize?x=1).\n"
    expect(extractAuthorizeUrl(ansi)).toBe("https://claude.com/oauth/authorize?x=1")
    const two = "https://example.com/docs https://claude.ai/oauth/authorize?y=2"
    expect(extractAuthorizeUrl(two)).toBe("https://claude.ai/oauth/authorize?y=2")
    expect(extractAuthorizeUrl("https://example.com/nothing")).toBeUndefined()
    expect(extractAuthorizeUrl(stripAnsi("\u001B[2Jclean"))).toBeUndefined()
  })

  test("invalid-code notices and meaningful lines", () => {
    expect(looksLikeInvalidCodeNotice("Invalid code. Please make sure the full code was copied.")).toBe(true)
    expect(looksLikeInvalidCodeNotice("all good")).toBe(false)
    expect(firstMeaningfulLine("\n  \n  second line\n")).toBe("second line")
  })
})

// ── Fake spawn fixtures ──

class FakeSpawnHandle implements SpawnHandle {
  pid = 4321
  written: string[] = []
  killed = false
  private chunks: Array<(chunk: StreamChunk) => void> = []
  private buffered: StreamChunk[] = []
  private doneResolvers: Array<(result: IteratorResult<StreamChunk>) => void> = []
  private closed = false
  exitResolver!: (exit: { code: number | null; signal: string | null }) => void
  readonly exit: Promise<{ code: number | null; signal: string | null }>

  constructor() {
    this.exit = new Promise((resolve) => {
      this.exitResolver = resolve
    })
  }

  write(text: string): boolean {
    this.written.push(text)
    return true
  }

  end(): void {}

  kill(): void {
    if (this.killed) return
    this.killed = true
    this.close()
    this.exitResolver({ code: null, signal: "SIGTERM" })
  }

  /** Fixture driver: emit CLI output. */
  emit(stream: "stdout" | "stderr", text: string): void {
    if (this.chunks.length === 0) {
      this.buffered.push({ stream, text })
      return
    }
    for (const chunk of [...this.chunks]) chunk({ stream, text })
  }

  /** Fixture driver: process exits normally. */
  finish(code: number): void {
    this.close()
    this.exitResolver({ code, signal: null })
  }

  private close(): void {
    this.closed = true
    this.chunks = []
    for (const resolve of this.doneResolvers) resolve({ done: true, value: undefined })
    this.doneResolvers = []
  }

  get output(): AsyncIterable<StreamChunk> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<StreamChunk>>((resolve) => {
              if (self.closed) return resolve({ done: true, value: undefined })
              const buffered = self.buffered.shift()
              if (buffered) return resolve({ done: false, value: buffered })
              self.chunks.push((chunk) => resolve({ done: false, value: chunk }))
              self.doneResolvers.push(resolve)
            }),
        }
      },
    }
  }
}

  function relayPort(handle: FakeSpawnHandle, execImpl?: ClaudeProcessPort["exec"]): ClaudeProcessPort & { spawns: Array<{ file: string; args: readonly string[] }> } {
    const spawns: Array<{ file: string; args: readonly string[] }> = []
  return {
    spawns,
    async exec(file, args, options) {
      if (execImpl) return execImpl(file, args, options)
      return { code: 0, signal: null, stdout: "", stderr: "" }
    },
    async spawn(file, args) {
      spawns.push({ file, args })
      return handle
    },
  }
}

const URL_LINE = "If the browser didn't open, visit: https://claude.com/oauth/authorize?code=xyz\n"

describe("CliLoginRelay", () => {
  test("start relays the authorize URL and submitCode pipes it to CLI stdin; success is exit code only", async () => {
    const handle = new FakeSpawnHandle()
    const port = relayPort(handle)
    const relay = new CliLoginRelay({ process: port, binaryPath: "/usr/bin/claude", urlTimeoutMs: 500, verifyTimeoutMs: 500 })

    const started = relay.start()
    await Promise.resolve()
    handle.emit("stdout", URL_LINE)
    const state = await started
    expect(state).toEqual({ state: "awaiting-code", url: "https://claude.com/oauth/authorize?code=xyz" })
    expect(port.spawns[0]).toEqual({ file: "/usr/bin/claude", args: ["auth", "login", "--claudeai"] })

    const submitted = relay.submitCode("  abcd-efgh  ")
    await Promise.resolve()
    expect(handle.written).toEqual(["abcd-efgh\n"])

    handle.finish(0)
    expect(await submitted).toEqual({ ok: true })
    expect(relay.state).toEqual({ state: "succeeded" })
    relay.cancel()
  })

  test("rejected code keeps the flow alive with a sanitized message", async () => {
    const handle = new FakeSpawnHandle()
    const relay = new CliLoginRelay({ process: relayPort(handle), binaryPath: "/usr/bin/claude", urlTimeoutMs: 500, verifyTimeoutMs: 500 })
    const started = relay.start()
    await Promise.resolve()
    handle.emit("stdout", URL_LINE)
    await started

    const submitted = relay.submitCode("bad-code")
    await Promise.resolve()
    handle.emit("stderr", "\u001B[31mInvalid code. Please make sure the full code was copied.\u001B[0m\n")
    const result = await submitted
    expect(result.ok).toBe(false)
    expect(result.message).toContain("Invalid code")
    // The CLI stays alive so the same challenge can be retried.
    expect(relay.state.state).toBe("failed")
    expect(handle.killed).toBe(false)
    relay.cancel()
  })

  test("non-zero exit after submit fails with the CLI's own notice", async () => {
    const handle = new FakeSpawnHandle()
    const relay = new CliLoginRelay({ process: relayPort(handle), binaryPath: "/usr/bin/claude", urlTimeoutMs: 500, verifyTimeoutMs: 500 })
    const started = relay.start()
    await Promise.resolve()
    handle.emit("stdout", URL_LINE)
    await started

    const submitted = relay.submitCode("expired-code")
    await Promise.resolve()
    handle.emit("stderr", "Authorization code has expired.\n")
    handle.finish(1)
    const result = await submitted
    expect(result.ok).toBe(false)
    expect(result.message).toContain("expired")
  })

  test("missing URL within timeout cancels the process and reports failure", async () => {
    const handle = new FakeSpawnHandle()
    const relay = new CliLoginRelay({ process: relayPort(handle), binaryPath: "/usr/bin/claude", urlTimeoutMs: 30 })
    const state = await relay.start()
    expect(state.state).toBe("failed")
    expect(handle.killed).toBe(true)
  }, 2000)

  test("cancel kills the child and resets transient state", async () => {
    const handle = new FakeSpawnHandle()
    const relay = new CliLoginRelay({ process: relayPort(handle), binaryPath: "/usr/bin/claude", urlTimeoutMs: 500 })
    const started = relay.start()
    await Promise.resolve()
    handle.emit("stdout", URL_LINE)
    await started
    relay.cancel()
    expect(handle.killed).toBe(true)
    expect(relay.state).toEqual({ state: "idle" })
  })

  test("no credential material ever surfaces through the relay", async () => {
    const handle = new FakeSpawnHandle()
    const relay = new CliLoginRelay({ process: relayPort(handle), binaryPath: "/usr/bin/claude", urlTimeoutMs: 500, verifyTimeoutMs: 500 })
    const started = relay.start()
    await Promise.resolve()
    // CLI echoes a fake token in its banner — must not leak into state.
    handle.emit("stdout", `token=sk-ant-faketoken123\n${URL_LINE}`)
    const state = await started
    expect(JSON.stringify(state)).not.toContain("sk-ant-faketoken123")
    relay.cancel()
  })
})

describe("installCli relay", () => {
  function installPort(results: ExecResult[]): ClaudeProcessPort & { calls: Array<{ file: string; args: readonly string[] }> } {
    const calls: Array<{ file: string; args: readonly string[] }> = []
    let index = 0
    return {
      calls,
      async exec(file, args) {
        calls.push({ file, args })
        const result = results[index]
        index += 1
        return result ?? { code: 127, signal: null, stdout: "", stderr: "", error: "spawn npm ENOENT" }
      },
      async spawn() {
        throw new Error("not expected")
      },
    }
  }

  test("npm success installs without fallback", async () => {
    const port = installPort([{ code: 0, signal: null, stdout: "", stderr: "" }])
    const result = await installCli({ process: port })
    expect(result.ok).toBe(true)
    expect(port.calls.length).toBe(1)
    expect(port.calls[0]).toEqual({ file: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] })
  })

  test("npm failure falls back to the official script installer", async () => {
    const port = installPort([
      { code: 1, signal: null, stdout: "", stderr: "npm ERR! network unreachable" },
      { code: 0, signal: null, stdout: "installed", stderr: "" },
    ])
    const result = await installCli({ process: port })
    expect(result.ok).toBe(true)
    expect(port.calls.length).toBe(2)
    expect(port.calls[1]!.file).toBe("bash")
    expect(port.calls[1]!.args[0]).toBe("-lc")
    expect(String(port.calls[1]!.args[1])).toContain("claude.ai/install.sh")
  })

  test("both failures report the first meaningful line, sanitized", async () => {
    const port = installPort([
      { code: 1, signal: null, stdout: "", stderr: "EACCES permission denied" },
      { code: 2, signal: null, stdout: "", stderr: "curl: command not found" },
    ])
    const result = await installCli({ process: port })
    expect(result.ok).toBe(false)
    expect(result.message).toContain("permission denied")
  })
})
