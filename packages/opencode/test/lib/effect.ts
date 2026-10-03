import { test, type TestOptions } from "bun:test"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { Cause, Duration, Effect, Exit, Layer } from "effect"
import * as Scope from "effect/Scope"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { memoMap } from "@opencode-ai/core/effect/memo-map"
import type { Config } from "@/config/config"
import { TestInstance, withTmpdirInstance } from "../fixture/fixture"
import { InstanceStore } from "@/project/instance-store"

type Body<A, E, R> = Effect.Effect<A, E, R> | (() => Effect.Effect<A, E, R>)
type InstanceOptions<E, R> = {
  git?: boolean
  config?: Partial<ConfigV1.Info> | (() => Partial<ConfigV1.Info>)
  init?: (directory: string) => Effect.Effect<void, E, R>
}

function isInstanceOptions<E, R>(
  options: InstanceOptions<E, R> | number | TestOptions | undefined,
): options is InstanceOptions<E, R> {
  return !!options && typeof options === "object" && ("git" in options || "config" in options || "init" in options)
}

function instanceArgs<E, R>(
  options?: InstanceOptions<E, R> | number | TestOptions,
  testOptions?: number | TestOptions,
): { instanceOptions: InstanceOptions<E, R> | undefined; testOptions: number | TestOptions | undefined } {
  if (typeof options === "number") return { instanceOptions: undefined, testOptions: options }
  if (isInstanceOptions(options)) return { instanceOptions: options, testOptions }
  return { instanceOptions: undefined, testOptions: options }
}

const body = <A, E, R>(value: Body<A, E, R>) => Effect.suspend(() => (typeof value === "function" ? value() : value))

type Runner = <A, E, R, E2>(
  value: Body<A, E, R | Scope.Scope>,
  layer: Layer.Layer<R, E2>,
  signal?: AbortSignal,
) => Promise<A>

const isolatedRun: Runner = (value, layer, signal) =>
  Effect.gen(function* () {
    const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(layer), Effect.exit)
    if (Exit.isFailure(exit)) {
      for (const err of Cause.prettyErrors(exit.cause)) {
        yield* Effect.logError(err)
      }
    }
    return yield* exit
  }).pipe((effect) => Effect.runPromise(effect, { signal }))

// Builds the test layer through the shared process-wide memoMap so cached
// services (Bus, Session, …) match Server.Default's instances. Use for tests
// that publish to an in-process HTTP server and need pub/sub identity with
// the server's handlers.
const sharedRun: Runner = (value, layer, signal) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    return yield* Effect.gen(function* () {
      const ctx = yield* Layer.buildWithMemoMap(layer, memoMap, scope)
      const exit = yield* body(value).pipe(Effect.scoped, Effect.provide(ctx), Effect.exit)
      if (Exit.isFailure(exit)) {
        for (const err of Cause.prettyErrors(exit.cause)) {
          yield* Effect.logError(err)
        }
      }
      return yield* exit
    }).pipe(
      // The AbortSignal used by runForTest interrupts the outer Effect at the
      // caller's semantic deadline. The manually-owned shared layer scope must
      // therefore be structural cleanup, not a subsequent statement that an
      // interruption can skip. Preserve the real Exit so failure-sensitive
      // releases observe timeout/interruption instead of synthetic success.
      Effect.onExit((exit) => Scope.close(scope, exit)),
    )
  }).pipe((effect) => Effect.runPromise(effect, { signal }))

const DEFAULT_BUN_TEST_TIMEOUT_MS = 5_000
const TEST_CLEANUP_GRACE_MS = 5_000
const EFFECT_TEST_TIMEOUT_ENV = "OPENCODE_EFFECT_TEST_TIMEOUT_MS"

function configuredTestTimeout() {
  const raw = process.env[EFFECT_TEST_TIMEOUT_ENV]?.trim()
  if (!raw) return DEFAULT_BUN_TEST_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${EFFECT_TEST_TIMEOUT_ENV} must be a positive timeout in milliseconds`)
  }
  return value
}

// Bun strips runner flags such as --timeout from process.argv/Bun.argv before a
// test module executes, so the Effect harness cannot truthfully infer the CLI
// deadline. The canonical package test script exports this value alongside
// Bun's --timeout; raw `bun test` deliberately retains Bun's 5s default.
const PROCESS_TEST_TIMEOUT_MS = configuredTestTimeout()

function testTimeout(options?: number | TestOptions) {
  if (options === 0 || options === Infinity) return 0
  if (typeof options === "number" && Number.isFinite(options) && options > 0) return options
  if (options && typeof options === "object") {
    const value = (options as TestOptions & { timeout?: number }).timeout
    if (value === 0 || value === Infinity) return 0
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  }
  return PROCESS_TEST_TIMEOUT_MS
}

function withCleanupGrace(options: number | TestOptions | undefined, timeout: number): TestOptions {
  if (timeout === 0) {
    if (options && typeof options === "object") return { ...options, timeout: 0 }
    return { timeout: 0 }
  }
  const outerTimeout = timeout + TEST_CLEANUP_GRACE_MS
  if (options && typeof options === "object") return { ...options, timeout: outerTimeout }
  return { timeout: outerTimeout }
}

class EffectTestTimeout extends Error {
  constructor(timeout: number, options?: ErrorOptions) {
    super(`Effect-backed test timed out after ${timeout}ms`, options)
    this.name = "EffectTestTimeout"
  }
}

/**
 * Bun's Promise-test timeout is a hard outer deadline, not cancellation. Give
 * Effect the requested test budget and Bun a small cleanup grace window:
 *
 *   Effect deadline -> AbortSignal -> scoped finalizers -> rejected test
 *                                           |
 *                                           +-- Bun hard deadline (fallback)
 *
 * This keeps the caller's timeout semantics while preventing ordinary timed-out
 * Effect fibers from surviving into the next test's fixture teardown.
 */
const runForTest = <A, E, R, E2>(
  run: Runner,
  value: Body<A, E, R | Scope.Scope>,
  layer: Layer.Layer<R, E2>,
  timeout: number,
) => {
  if (timeout === 0) return run(value, layer)
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  const execution = run(value, layer, controller.signal)
  return execution
    .then(
      (result) => {
        // If the timer won the race, crossing the semantic deadline remains a
        // timeout even if the Effect happens to settle successfully while the
        // abort is propagating through finalizers.
        if (timedOut) throw new EffectTestTimeout(timeout)
        return result
      },
      (cause) => {
        if (timedOut) throw new EffectTestTimeout(timeout, { cause })
        throw cause
      },
    )
    .finally(() => {
      clearTimeout(timer)
    })
}

const make = <R, E>(testLayer: Layer.Layer<R, E>, liveLayer: Layer.Layer<R, E>, run: Runner = isolatedRun) => {
  const effect = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) => {
    const timeout = testTimeout(opts)
    return test(name, () => runForTest(run, value, testLayer, timeout), withCleanupGrace(opts, timeout))
  }

  effect.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) => {
    const timeout = testTimeout(opts)
    return test.only(name, () => runForTest(run, value, testLayer, timeout), withCleanupGrace(opts, timeout))
  }

  effect.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) => {
    const timeout = testTimeout(opts)
    return test.skip(name, () => runForTest(run, value, testLayer, timeout), withCleanupGrace(opts, timeout))
  }

  const live = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) => {
    const timeout = testTimeout(opts)
    return test(name, () => runForTest(run, value, liveLayer, timeout), withCleanupGrace(opts, timeout))
  }

  live.only = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) => {
    const timeout = testTimeout(opts)
    return test.only(name, () => runForTest(run, value, liveLayer, timeout), withCleanupGrace(opts, timeout))
  }

  live.skip = <A, E2>(name: string, value: Body<A, E2, R | Scope.Scope>, opts?: number | TestOptions) => {
    const timeout = testTimeout(opts)
    return test.skip(name, () => runForTest(run, value, liveLayer, timeout), withCleanupGrace(opts, timeout))
  }

  const instance = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    const timeout = testTimeout(args.testOptions)
    return test(
      name,
      () => runForTest(run, body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, timeout),
      withCleanupGrace(args.testOptions, timeout),
    )
  }

  instance.only = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    const timeout = testTimeout(args.testOptions)
    return test.only(
      name,
      () => runForTest(run, body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, timeout),
      withCleanupGrace(args.testOptions, timeout),
    )
  }

  instance.skip = <A, E2, E3 = never>(
    name: string,
    value: Body<A, E2, R | InstanceStore.Service | TestInstance | Scope.Scope>,
    options?: InstanceOptions<E3, R | Scope.Scope> | number | TestOptions,
    opts?: number | TestOptions,
  ) => {
    const args = instanceArgs(options, opts)
    const timeout = testTimeout(args.testOptions)
    return test.skip(
      name,
      () => runForTest(run, body(value).pipe(withTmpdirInstance(args.instanceOptions)), liveLayer, timeout),
      withCleanupGrace(args.testOptions, timeout),
    )
  }

  return { effect, live, instance }
}

// Test environment with TestClock and TestConsole
const testEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())

// Live environment - uses real clock, but keeps TestConsole for output capture
const liveEnv = TestConsole.layer

export const it = make<never, never>(testEnv, liveEnv)

export const testEffect = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv))

// Variant of `testEffect` that builds the test layer through the shared
// process-wide memoMap so services like Bus/Session resolve to the same
// instances Server.Default uses. Use when a test needs pub/sub identity with
// an in-process HTTP server — most tests should stick with `testEffect`.
export const testEffectShared = <R, E>(layer: Layer.Layer<R, E>) =>
  make<R, E>(Layer.provideMerge(layer, testEnv), Layer.provideMerge(layer, liveEnv), sharedRun)

export const awaitWithTimeout = <A, E, R>(
  self: Effect.Effect<A, E, R>,
  message: string,
  duration: Duration.Input = "2 seconds",
) =>
  self.pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(message)),
    }),
  )

export const pollWithTimeout = <A, E, R>(
  self: Effect.Effect<A | undefined, E, R>,
  message: string,
  duration: Duration.Input = "5 seconds",
) =>
  Effect.gen(function* () {
    while (true) {
      const result = yield* self
      if (result !== undefined) return result
      yield* Effect.sleep("20 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(message)),
    }),
  )
