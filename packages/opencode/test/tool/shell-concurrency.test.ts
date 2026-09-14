import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Ref } from "effect"
import {
  classifyShellCommand,
  configuredIoShellPermits,
  defaultIoShellPermits,
  IO_SHELL_ENV,
  resetForTesting,
  withShellSlot,
} from "../../src/tool/shell-concurrency"
import {
  configuredHeavyProcessPermits,
  defaultHeavyProcessPermits,
  HEAVY_TOOL_ENV,
  MAX_SAFE_HEAVY_JOBS,
  UNSAFE_DISABLE_ENV,
  withHeavyProcessSlot,
} from "../../src/tool/heavy-process-concurrency"

const ENV_KEY = "OPENCODE_MAX_CONCURRENT_SHELL_COMMANDS"

function withEnv<A>(value: string | undefined, body: () => Promise<A>): Promise<A> {
  const prior = process.env[ENV_KEY]
  if (value === undefined) delete process.env[ENV_KEY]
  else process.env[ENV_KEY] = value
  resetForTesting()
  return body().finally(() => {
    if (prior === undefined) delete process.env[ENV_KEY]
    else process.env[ENV_KEY] = prior
    resetForTesting()
  })
}

describe("shell concurrency", () => {
  test("bounds concurrently running effects and queues the rest", async () => {
    await withEnv("2", async () => {
      const gate = await Effect.runPromise(Deferred.make<void>())
      const active = await Effect.runPromise(Ref.make(0))
      const peak = await Effect.runPromise(Ref.make(0))
      const worker = withShellSlot(
        "bun test",
        Effect.gen(function* () {
          const current = yield* Ref.updateAndGet(active, (n) => n + 1)
          yield* Ref.update(peak, (max) => Math.max(max, current))
          yield* Deferred.await(gate)
          yield* Ref.update(active, (n) => n - 1)
        }),
      )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(
              Effect.all([worker, worker, worker], { concurrency: "unbounded", discard: true }),
            )
            // Wait until two slots are occupied; the third worker must still
            // be queued, so the observed peak never exceeds the bound.
            while ((yield* Ref.get(active)) < 2) yield* Effect.sleep("5 millis")
            yield* Effect.sleep("50 millis")
            expect(yield* Ref.get(peak)).toBe(2)
            expect(yield* Ref.get(active)).toBe(2)
            // Opening the gate lets the queued worker (and the holders)
            // finish: queueing never fails the work.
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(fiber)
            expect(yield* Ref.get(active)).toBe(0)
          }),
        ).pipe(
          Effect.timeoutOrElse({
            duration: "15 seconds",
            orElse: () => Effect.die(new Error("workers never settled")),
          }),
        ),
      )
    })
  })

  test("zero no longer disables the thermal guard", async () => {
    await withEnv("0", async () => {
      expect(configuredHeavyProcessPermits()).toBe(defaultHeavyProcessPermits())
    })
  })

  test("invalid values fall back to the default bound", async () => {
    await withEnv("not-a-number", async () => {
      const value = await Effect.runPromise(withShellSlot("bun test", Effect.succeed("ok")))
      expect(value).toBe("ok")
    })
  })

  test("failures release the slot", async () => {
    await withEnv("1", async () => {
      await expect(Effect.runPromise(withShellSlot("bun test", Effect.fail(new Error("boom"))))).rejects.toThrow("boom")
      // The permit must be free again: a second acquisition completes.
      await Effect.runPromise(withShellSlot("bun test", Effect.void))
    })
  })

  test("defaults stay conservative on high-core machines", () => {
    expect(defaultHeavyProcessPermits(4)).toBe(1)
    expect(defaultHeavyProcessPermits(8)).toBe(1)
    expect(defaultHeavyProcessPermits(12)).toBe(2)
    expect(defaultHeavyProcessPermits(24)).toBe(2)
    expect(defaultHeavyProcessPermits(128)).toBe(2)
  })

  test("explicit heavy-tool override is hard-capped", () => {
    const env = { [HEAVY_TOOL_ENV]: "999" }
    expect(configuredHeavyProcessPermits(env)).toBe(MAX_SAFE_HEAVY_JOBS)
  })

  test("unsafe disable requires the explicit unsafe flag", () => {
    expect(configuredHeavyProcessPermits({ [HEAVY_TOOL_ENV]: "0" })).toBe(defaultHeavyProcessPermits())
    expect(configuredHeavyProcessPermits({ [UNSAFE_DISABLE_ENV]: "1" })).toBeUndefined()
  })

  test("shell and dedicated heavy tools share one semaphore", async () => {
    const priorHeavy = process.env[HEAVY_TOOL_ENV]
    process.env[HEAVY_TOOL_ENV] = "1"
    resetForTesting()
    try {
      const gate = await Effect.runPromise(Deferred.make<void>())
      const active = await Effect.runPromise(Ref.make(0))
      const peak = await Effect.runPromise(Ref.make(0))
      const work = (wrapper: typeof withHeavyProcessSlot) =>
        wrapper(
          Effect.gen(function* () {
            const now = yield* Ref.updateAndGet(active, (n) => n + 1)
            yield* Ref.update(peak, (n) => Math.max(n, now))
            yield* Deferred.await(gate)
            yield* Ref.update(active, (n) => n - 1)
          }),
        )
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const fiber = yield* Effect.forkScoped(
              Effect.all([work((effect) => withShellSlot("bun test", effect)), work(withHeavyProcessSlot)], {
                concurrency: "unbounded",
                discard: true,
              }),
            )
            while ((yield* Ref.get(active)) < 1) yield* Effect.sleep("5 millis")
            yield* Effect.sleep("30 millis")
            expect(yield* Ref.get(peak)).toBe(1)
            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(fiber)
          }),
        ),
      )
    } finally {
      if (priorHeavy === undefined) delete process.env[HEAVY_TOOL_ENV]
      else process.env[HEAVY_TOOL_ENV] = priorHeavy
      resetForTesting()
    }
  })

  test("classifies only simple known waiting commands into the I/O pool", () => {
    expect(classifyShellCommand("curl https://example.com")).toBe("io")
    expect(classifyShellCommand("Start-Sleep -Seconds 30")).toBe("io")
    expect(classifyShellCommand("docker logs -f app")).toBe("io")
    expect(classifyShellCommand("kubectl wait --for=condition=ready pod/x")).toBe("io")
    expect(classifyShellCommand("tail -f server.log")).toBe("io")
    expect(classifyShellCommand("Get-Content server.log -Wait")).toBe("io")
    expect(classifyShellCommand("bun test")).toBe("heavy")
    expect(classifyShellCommand("npm run build")).toBe("heavy")
    expect(classifyShellCommand("curl https://example.com | node parse.js")).toBe("heavy")
    expect(classifyShellCommand("sleep 30 && bun test")).toBe("heavy")
  })

  test("I/O shell budget is wider but bounded", () => {
    expect(defaultIoShellPermits(4)).toBe(4)
    expect(defaultIoShellPermits(24)).toBe(6)
    expect(defaultIoShellPermits(128)).toBe(8)
    expect(configuredIoShellPermits({ [IO_SHELL_ENV]: "999" })).toBe(12)
    expect(configuredIoShellPermits({ [IO_SHELL_ENV]: "0" })).toBe(defaultIoShellPermits())
  })

  test("waiting I/O commands do not consume the heavy-tool semaphore", async () => {
    const priorHeavy = process.env[HEAVY_TOOL_ENV]
    const priorIo = process.env[IO_SHELL_ENV]
    process.env[HEAVY_TOOL_ENV] = "1"
    process.env[IO_SHELL_ENV] = "2"
    resetForTesting()
    try {
      const heavyGate = await Effect.runPromise(Deferred.make<void>())
      const ioStarted = await Effect.runPromise(Deferred.make<void>())
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const heavy = yield* Effect.forkScoped(withHeavyProcessSlot(Deferred.await(heavyGate)))
            yield* Effect.sleep("20 millis")
            const io = yield* Effect.forkScoped(
              withShellSlot(
                "sleep 30",
                Effect.gen(function* () {
                  yield* Deferred.succeed(ioStarted, undefined)
                }),
              ),
            )
            yield* Deferred.await(ioStarted).pipe(Effect.timeout("1 second"))
            yield* Deferred.succeed(heavyGate, undefined)
            yield* Fiber.join(heavy)
            yield* Fiber.join(io)
          }),
        ),
      )
    } finally {
      if (priorHeavy === undefined) delete process.env[HEAVY_TOOL_ENV]
      else process.env[HEAVY_TOOL_ENV] = priorHeavy
      if (priorIo === undefined) delete process.env[IO_SHELL_ENV]
      else process.env[IO_SHELL_ENV] = priorIo
      resetForTesting()
    }
  })
})
