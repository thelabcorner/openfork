import { describe, test, expect } from "bun:test"
import { ClaudeAgentRuntime, normalizeQueryResult } from "../../src/claude/runtime"
import { ClaudeDisposedError } from "../../src/claude/errors"
import type { SdkQueryHandle, SdkQueryRequest } from "../../src/claude/runtime"

// ── Fake SDK fixtures ──

class StreamController {
  private queue: unknown[] = []
  private resolvers: Array<(result: IteratorResult<unknown>) => void> = []
  private ended = false
  private failed = false

  push(value: unknown): void {
    const resolver = this.resolvers.shift()
    if (resolver) resolver({ done: false, value })
    else this.queue.push(value)
  }

  end(): void {
    this.ended = true
    for (const resolver of this.resolvers.splice(0)) resolver({ done: true, value: undefined })
  }

  fail(error: unknown): void {
    this.failed = true
    for (const resolver of this.resolvers.splice(0)) resolver({ done: true, value: undefined })
    void error
    // Errors surface through the iterator contract below.
    this.pendingError = error
  }

  private pendingError: unknown

  get events(): AsyncIterable<unknown> {
    const self = this
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<unknown>>((resolve, reject) => {
              const queued = self.queue.shift()
              if (queued !== undefined) return resolve({ done: false, value: queued })
              if (self.failed && self.pendingError) return reject(self.pendingError)
              if (self.ended || self.failed) return resolve({ done: true, value: undefined })
              self.resolvers.push(resolve)
            }),
        }
      },
    }
  }
}

interface FixtureQuery {
  readonly handle: SdkQueryHandle & { interruptCalls: number; closeCalls: number }
}

function fixtureSdk(
  streams: StreamController[],
  pid = 4242,
): {
  module: { query: (input: SdkQueryRequest) => unknown }
  queryCalls: SdkQueryRequest[]
} {
  const queryCalls: SdkQueryRequest[] = []
  return {
    queryCalls,
    module: {
      query(input) {
        queryCalls.push(input)
        const stream = streams.shift() ?? new StreamController()
        const handle = {
          interruptCalls: 0,
          closeCalls: 0,
          events: stream.events,
          pid,
          interrupt: async () => {
            handle.interruptCalls += 1
          },
          close: () => {
            handle.closeCalls += 1
            stream.end()
          },
        }
        return handle
      },
    },
  }
}

const initEvent = { type: "system", subtype: "init", session_id: "ext-session-1", model: "claude-sonnet-4-5" }
const resultEvent = {
  type: "result",
  subtype: "success",
  is_error: false,
  result: "final answer",
  usage: { input_tokens: 11, output_tokens: 7 },
}

function makeRuntime(
  module: { query: (input: SdkQueryRequest) => unknown },
  overrides: Partial<ConstructorParameters<typeof ClaudeAgentRuntime>[0]> = {},
): { runtime: ClaudeAgentRuntime; killed: number[]; sinkEvents: Array<{ kind: string }> } {
  const killed: number[] = []
  const sinkEvents: Array<{ kind: string }> = []
  const runtime = new ClaudeAgentRuntime({
    loader: async () => module,
    killTree: (pid) => {
      killed.push(pid)
    },
    sink: (event) => {
      sinkEvents.push({ kind: event.kind })
    },
    ...overrides,
  })
  return { runtime, killed, sinkEvents }
}

describe("ClaudeAgentRuntime lifecycle", () => {
  test("happy path completes with result text, session id, and event sequence", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime, sinkEvents } = makeRuntime(fixture.module)

    const done = runtime.run({ prompt: "hello world" })
    stream.push(initEvent)
    stream.push({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })
    stream.push(resultEvent)
    stream.end()

    const outcome = await done
    expect(outcome.status).toBe("completed")
    expect(outcome.resultText).toBe("final answer")
    expect(outcome.sessionID).toBe("ext-session-1")
    expect(outcome.usage).toEqual({ input_tokens: 11, output_tokens: 7 })
    expect(sinkEvents.map((e) => e.kind)).toEqual(["started", "transport", "transport", "transport", "completed"])
    // Query options carry the credential-stripped env and preset system prompt.
    expect(fixture.queryCalls.length).toBe(1)
    expect(fixture.queryCalls[0]!.prompt).toBe("hello world")
    expect(fixture.queryCalls[0]!.options.systemPrompt).toEqual({ type: "preset", preset: "claude_code" })
    expect(fixture.queryCalls[0]!.options.autoCompactEnabled).toBe(true)
    expect(fixture.queryCalls[0]!.options.skills).toBe("all")
    expect(fixture.queryCalls[0]!.options.settingSources).toEqual(["user", "project", "local"])
    expect(fixture.queryCalls[0]!.options.includePartialMessages).toBe(true)

    const diag = runtime.diagnostics()
    expect(diag.turnsStarted).toBe(1)
    expect(diag.completed).toBe(1)
    expect(diag.lastFailureCategory).toBeUndefined()
  })

  test("SDK error result fails the turn instead of persisting a successful completion", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime } = makeRuntime(fixture.module)
    const done = runtime.run({ prompt: "fail" })
    stream.push(initEvent)
    stream.push({ type: "result", subtype: "error", is_error: true, result: "provider rejected request" })
    stream.end()

    const outcome = await done
    expect(outcome.status).toBe("failed")
    expect(outcome.category).toBe("provider-error")
    expect(outcome.message).toBe("provider rejected request")
    expect(outcome.resultText).toBeUndefined()
  })

  test("effort variant maps to Agent SDK effort + adaptive thinking", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime } = makeRuntime(fixture.module)
    const done = runtime.run({ prompt: "think", effort: "high" })
    stream.push(initEvent)
    stream.push(resultEvent)
    stream.end()
    await done
    expect(fixture.queryCalls[0]!.options.effort).toBe("high")
    expect(fixture.queryCalls[0]!.options.thinking).toEqual({ type: "adaptive" })
  })

  test("SDK is loaded lazily and memoized across turns", async () => {
    let loads = 0
    const streamA = new StreamController()
    const streamB = new StreamController()
    const streams = [streamA, streamB]
    const queryCalls: SdkQueryRequest[] = []
    const module = {
      query: (input: SdkQueryRequest) => {
        queryCalls.push(input)
        const stream = streams.shift() ?? new StreamController()
        return {
          events: stream.events,
          interrupt: async () => {},
          close: () => stream.end(),
          pid: 1,
        }
      },
    }
    const loader = async () => {
      loads += 1
      return module
    }
    const runtime = new ClaudeAgentRuntime({ loader })

    const first = runtime.run({ prompt: "one" })
    streamA.push(initEvent)
    streamA.push(resultEvent)
    await first

    const second = runtime.run({ prompt: "two" })
    streamB.push(initEvent)
    streamB.push(resultEvent)
    await second

    expect(loads).toBe(1)
    expect(queryCalls.length).toBe(2)
  })

  test("abort signal cancels the turn and cleans up the child", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime, killed } = makeRuntime(fixture.module)
    const controller = new AbortController()

    const done = runtime.run({ prompt: "long turn", signal: controller.signal })
    stream.push(initEvent)
    await Promise.resolve()
    await Promise.resolve()
    controller.abort()

    const outcome = await done
    expect(outcome.status).toBe("cancelled")
    expect(killed).toEqual([4242])
    const diag = runtime.diagnostics()
    expect(diag.cancelled).toBe(1)
  })

  test("silence beyond the stall window fails the turn as stalled", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime, killed, sinkEvents } = makeRuntime(fixture.module, { timeouts: { stallMs: 25, turnMs: 10_000 } })

    const done = runtime.run({ prompt: "stall me" })
    stream.push(initEvent)
    // No further events — stall timer fires.

    const outcome = await done
    expect(outcome.status).toBe("stalled")
    expect(killed).toEqual([4242])
    expect(sinkEvents.some((e) => e.kind === "stalled")).toBe(true)
    expect(runtime.diagnostics().stalled).toBe(1)
  }, 2000)

  test("overall deadline fails the turn as timedOut even with no events", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime } = makeRuntime(fixture.module, { timeouts: { turnMs: 25, stallMs: 10_000 } })

    const outcome = await runtime.run({ prompt: "hang" })
    expect(outcome.status).toBe("timedOut")
    expect(runtime.diagnostics().timedOut).toBe(1)
  }, 2000)

  test("disposal during an active turn settles it as disposed and rejects later runs", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime, killed } = makeRuntime(fixture.module)

    const done = runtime.run({ prompt: "active" })
    stream.push(initEvent)
    await Promise.resolve()
    await Promise.resolve()
    await runtime.dispose()

    const outcome = await done
    expect(outcome.status).toBe("disposed")
    expect(killed).toEqual([4242])

    await expect(runtime.run({ prompt: "after dispose" })).rejects.toBeInstanceOf(ClaudeDisposedError)
    // Idempotent.
    await runtime.dispose()
    expect(runtime.isDisposed).toBe(true)
  }, 2000)

  test("loader failure is a typed sdk-unavailable failure, not a crash", async () => {
    const runtime = new ClaudeAgentRuntime({
      loader: async () => {
        throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'")
      },
    })
    const outcome = await runtime.run({ prompt: "anything" })
    expect(outcome.status).toBe("failed")
    expect(outcome.category).toBe("sdk-unavailable")
    expect(runtime.diagnostics().sdkLoadFailures).toBe(1)
  })

  test("concurrent runs are rejected as busy", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime } = makeRuntime(fixture.module)

    const active = runtime.run({ prompt: "first" })
    await Promise.resolve()
    await Promise.resolve()
    const second = await runtime.run({ prompt: "second" })
    expect(second.status).toBe("failed")
    expect(second.category).toBe("busy")

    stream.push(initEvent)
    stream.push(resultEvent)
    const first = await active
    expect(first.status).toBe("completed")
  })

  test("stream errors are sanitized in outcomes and diagnostics", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime } = makeRuntime(fixture.module)

    const done = runtime.run({ prompt: "secret-prompt-content" })
    stream.push(initEvent)
    stream.fail(new Error("EPIPE broken pipe with sk-ant-leakedkeyvalue"))

    const outcome = await done
    expect(outcome.status).toBe("failed")
    expect(outcome.category).toBe("stream-error")
    expect(outcome.message).toContain("[redacted]")
    expect(JSON.stringify(runtime.diagnostics())).not.toContain("sk-ant-leakedkeyvalue")
    expect(JSON.stringify(runtime.diagnostics())).not.toContain("secret-prompt-content")
  })

  test("empty stream is a typed failure", async () => {
    const stream = new StreamController()
    const fixture = fixtureSdk([stream])
    const { runtime } = makeRuntime(fixture.module)

    const done = runtime.run({ prompt: "quiet" })
    stream.end()
    const outcome = await done
    expect(outcome.status).toBe("failed")
    expect(outcome.category).toBe("empty-stream")
  })

  test("rollback gate fails the turn as disabled without loading the SDK", async () => {
    let loads = 0
    const runtime = new ClaudeAgentRuntime({
      loader: async () => {
        loads += 1
        return { query: () => {} }
      },
      enabled: () => false,
    })
    const outcome = await runtime.run({ prompt: "gated" })
    expect(outcome.status).toBe("failed")
    expect(outcome.category).toBe("disabled")
    expect(loads).toBe(0)
    // No turn side effects recorded for a gated run.
    expect(runtime.diagnostics().turnsStarted).toBe(0)
    expect(runtime.diagnostics().sdkLoadFailures).toBe(0)
  })
})

describe("normalizeQueryResult", () => {
  test("accepts raw iterables with extras and handle-shaped results", async () => {
    const rawIterable = {
      async *[Symbol.asyncIterator]() {
        yield initEvent
      },
      interrupt: async () => {},
      pid: 7,
    }
    const handle = normalizeQueryResult(rawIterable)
    expect(handle.pid).toBe(7)
    for await (const _event of handle.events) break

    const wrapped = normalizeQueryResult({ events: rawIterable, close: () => {} })
    expect(wrapped.close).toBeTypeOf("function")
  })

  test("rejects non-stream results as sdk-unavailable defects", () => {
    expect(() => normalizeQueryResult(null)).toThrow()
    expect(() => normalizeQueryResult({})).toThrow()
  })
})
