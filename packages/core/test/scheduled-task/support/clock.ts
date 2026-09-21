import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"

/**
 * Deterministic clock harness (05-verification.md § 3), shared by the T2 engine
 * fixtures and the T3/T4/T9 service and runner tests.
 *
 * The engine itself takes `after` explicitly, so clock injection for pure
 * recurrence is just the fixture value. Runner and service tests run under
 * Effect's `TestClock` through `testEffect`, so `setNow`/`advance` are the
 * complete surface: no test ever sleeps for real time.
 */

export const at = (iso: string) => Date.parse(iso)

export const setNow = (epochMs: number) => TestClock.setTime(epochMs)

export const advance = (millis: number) => TestClock.adjust(millis)

/**
 * tzdata pin. Bun does not expose `process.versions.tz`, so the bundled ICU
 * version is the closest available proxy for the IANA database. The real pin
 * is the set of exact-epoch fixture assertions in `recurrence.test.ts`: if an
 * upgrade changes DST behavior they fail with this value attached.
 */
export function icuVersion(): string | undefined {
  return (process.versions as Record<string, string | undefined>).icu
}

export function tzPin(): string {
  return `ICU ${icuVersion() ?? "unknown"}`
}

/** Runs `body` and rethrows with the tzdata pin attached to the message. */
export function withTzPin<A>(body: () => A): A {
  try {
    return body()
  } catch (error) {
    if (error instanceof Error) error.message = `${error.message} [tzdata pin: ${tzPin()}]`
    throw error
  }
}

/** Test helper: true when `next` is strictly after `after`. */
export const strictlyAfter = (after: number) => (next: number | undefined) => next === undefined || next > after

export const noop = Effect.void
