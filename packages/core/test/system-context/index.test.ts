import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemSurface } from "@opencode-ai/core/system-surface"
import { it } from "../lib/effect"

const key = SystemContext.Key.make
const surfaceKey = SystemSurface.Key.make

const stringContext = (input: {
  key: string
  value: string | SystemContext.Unavailable
  availability?: SystemSurface.Availability
  render?: (value: string) => string
}) =>
  SystemContext.make({
    key: key(input.key),
    load: Effect.succeed(input.value),
    availability: input.availability,
    render: input.render ?? String,
  })

describe("SystemContext producers", () => {
  it.effect("observes and renders one exact complete section exactly once", () =>
    Effect.gen(function* () {
      let loads = 0
      let renders = 0
      const context = SystemContext.make({
        key: key("core/policy"),
        load: Effect.sync(() => {
          loads++
          return "CURRENT"
        }),
        render: (value) => {
          renders++
          return `Policy: ${value}`
        },
      })

      expect(yield* SystemContext.observeSurface(context)).toEqual({
        observations: [SystemSurface.present(surfaceKey("core/policy"), "Policy: CURRENT")],
        order: [surfaceKey("core/policy")],
      })
      expect(loads).toBe(1)
      expect(renders).toBe(1)
    }),
  )

  it.effect("represents unavailability explicitly without invoking the renderer", () =>
    Effect.gen(function* () {
      let renders = 0
      const context = SystemContext.make({
        key: key("core/optional"),
        load: Effect.succeed(SystemContext.unavailable),
        availability: "optional",
        render: (_value: string) => {
          renders++
          return "unreachable"
        },
      })

      expect(yield* SystemContext.observeSurface(context)).toEqual({
        observations: [SystemSurface.unavailable(surfaceKey("core/optional"), "optional")],
        order: [surfaceKey("core/optional")],
      })
      expect(renders).toBe(0)
    }),
  )

  it.effect("represents semantic absence explicitly without invoking the renderer", () =>
    Effect.gen(function* () {
      let renders = 0
      const context = SystemContext.make({
        key: key("core/removable"),
        load: Effect.succeed(SystemContext.absent),
        render: (_value: string) => {
          renders++
          return "unreachable"
        },
      })

      expect(yield* SystemContext.observeSurface(context)).toEqual({
        observations: [SystemSurface.absent(surfaceKey("core/removable"), "required")],
        order: [surfaceKey("core/removable")],
      })
      expect(renders).toBe(0)
    }),
  )

  it.effect("defaults source availability to required", () =>
    Effect.gen(function* () {
      expect(
        yield* SystemContext.observeSurface(
          stringContext({ key: "core/required", value: SystemContext.unavailable }),
        ),
      ).toEqual({
        observations: [SystemSurface.unavailable(surfaceKey("core/required"), "required")],
        order: [surfaceKey("core/required")],
      })
    }),
  )

  it.effect("preserves combine order exactly", () =>
    Effect.gen(function* () {
      const context = SystemContext.combine([
        stringContext({ key: "core/z", value: "Z" }),
        stringContext({ key: "core/a", value: "A" }),
      ])
      expect(yield* SystemContext.observeSurface(context)).toEqual({
        observations: [
          SystemSurface.present(surfaceKey("core/z"), "Z"),
          SystemSurface.present(surfaceKey("core/a"), "A"),
        ],
        order: [surfaceKey("core/z"), surfaceKey("core/a")],
      })
    }),
  )

  it.effect("observes the identity context without manufacturing state", () =>
    Effect.gen(function* () {
      expect(yield* SystemContext.observeSurface(SystemContext.empty)).toEqual({ observations: [], order: [] })
    }),
  )

  it.effect("rejects an empty rendered section at the producer boundary", () =>
    Effect.gen(function* () {
      const exit = yield* SystemContext.observeSurface(
        stringContext({ key: "core/empty", value: "value", render: () => "" }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("rendered an empty section")
    }),
  )

  it.effect("rejects duplicate source keys before observation", () =>
    Effect.sync(() => {
      expect(() =>
        SystemContext.combine([
          stringContext({ key: "core/date", value: "one" }),
          stringContext({ key: "core/date", value: "two" }),
        ]),
      ).toThrow(new SystemContext.DuplicateKeyError({ key: key("core/date") }))
    }),
  )

  it.effect("requires namespaced producer keys", () =>
    Effect.sync(() => {
      const decodeKey = Schema.decodeUnknownSync(SystemContext.Key)
      expect(decodeKey("core/date")).toBe(key("core/date"))
      expect(() => decodeKey("date")).toThrow()
    }),
  )

  it.effect("keeps the pre-SystemSurface row schema isolated as LegacySnapshot", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(SystemContext.LegacySnapshot)
      expect(decode({ "core/date": { value: "date", removed: "Date removed" } })).toEqual({
        [key("core/date")]: { value: "date", removed: "Date removed" },
      })
      expect(() => decode({ date: { value: "date" } })).toThrow()
      expect(() => decode({ "core/date": { value: "date", removed: "" } })).toThrow()
    }),
  )
})
