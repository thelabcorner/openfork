import { describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Tracer from "effect/Tracer"
import { sqliteQueryOrigin } from "../../src/database/sqlite-query-origin"

const origin = Effect.withFiber((fiber) => Effect.sync(() => sqliteQueryOrigin(fiber.context)))

describe("SQLite query origin forensics", () => {
  test("identifies stable Effect application method from its parent spans", async () => {
    const value = await Effect.runPromise(
      origin.pipe(
        Effect.withSpan("sql.execute"),
        Effect.withSpan("other.outer"),
        Effect.withSpan("SessionExecutionOwner.tryAcquire"),
      ),
    )
    expect(value).toBe("SessionExecutionOwner.tryAcquire")
  })

  test("rejects paths, user-provided identifiers, SQL text, and arbitrary span strings", async () => {
    for (const label of [
      "Session.fetch /C:/Secret",
      "SELECT private FROM stuff",
      "Session.get.some\nSecret",
      "Session.unnamed()",
      "someUserName.CustomAction",
      "Session.query.Parameters=TOPSECRET",
    ]) {
      const got = await Effect.runPromise(origin.pipe(Effect.withSpan(label)))
      expect(got).toBe("unknown")
    }
  })

  test("returns unknown when tracing is absent", () => {
    expect(sqliteQueryOrigin(Context.empty())).toBe("unknown")
  })

  test("rejects caller-supplied spans even when they resemble static operations but exceed length limits", async () => {
    const label = "Session." + "x".repeat(160)
    const got = await Effect.runPromise(origin.pipe(Effect.withSpan(label)))
    expect(got).toBe("unknown")
  })

  test("nested spans select the nearest known operation", async () => {
    const value = await Effect.runPromise(
      origin.pipe(Effect.withSpan("EventV2.publish"), Effect.withSpan("Session.run")),
    )
    expect(value).toBe("EventV2.publish")
  })
})
