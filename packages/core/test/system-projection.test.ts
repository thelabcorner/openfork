import { describe, expect, test } from "bun:test"
import type { EffectiveSystemMessageCapability } from "@opencode-ai/llm"
import { SystemProjection } from "@opencode-ai/core/system-projection"
import { SystemSurface } from "@opencode-ai/core/system-surface"

const key = SystemSurface.Key.make
const version = SystemSurface.ProjectionVersion.make
const capability = (history: EffectiveSystemMessageCapability["history"]): EffectiveSystemMessageCapability => ({
  history,
  turnScoped: false,
})

const sections = (...entries: ReadonlyArray<readonly [SystemSurface.Key, string]>): SystemSurface.Snapshot["sections"] =>
  Object.fromEntries(entries) as SystemSurface.Snapshot["sections"]

const ready = (
  observations: ReadonlyArray<SystemSurface.Observation>,
  previous?: SystemSurface.Snapshot,
  order?: ReadonlyArray<SystemSurface.Key>,
) => {
  const result = SystemSurface.reconcile({ observations, ...(order ? { order } : {}) }, previous)
  if (result._tag !== "Ready") throw new Error("expected ready System surface")
  return result
}

describe("SystemProjection", () => {
  test("separates model bytes, section structure, checkpoint, and projection identity", () => {
    const split = ready(
      [SystemSurface.present(key("core/a"), "A"), SystemSurface.present(key("core/b"), "B")],
      undefined,
      [key("core/a"), key("core/b")],
    ).snapshot
    const merged = ready([SystemSurface.present(key("core/ab"), "A\n\nB")]).snapshot

    expect(SystemProjection.modelBytesDigest(split)).toBe(SystemProjection.modelBytesDigest(merged))
    expect(SystemProjection.surfaceStateDigest(split)).not.toBe(SystemProjection.surfaceStateDigest(merged))
    expect(SystemProjection.checkpointDigest(split)).not.toBe(SystemProjection.checkpointDigest(merged))
  })

  test("projection-version churn changes only checkpoint identity when fresh model bytes and structure are identical", () => {
    const one: SystemSurface.Snapshot = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: sections([key("core/a"), "A"]),
    }
    const two: SystemSurface.Snapshot = { ...one, projectionVersion: version(2) }

    expect(SystemProjection.modelBytesDigest(one)).toBe(SystemProjection.modelBytesDigest(two))
    expect(SystemProjection.surfaceStateDigest(one)).toBe(SystemProjection.surfaceStateDigest(two))
    expect(SystemProjection.checkpointDigest(one)).not.toBe(SystemProjection.checkpointDigest(two))
  })

  test("length-prefixed framing distinguishes ambiguous section concatenations", () => {
    const left: SystemSurface.Snapshot = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: sections([key("core/a"), "ab"], [key("core/b"), "c"]),
    }
    const right: SystemSurface.Snapshot = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: sections([key("core/a"), "a"], [key("core/b"), "bc"]),
    }
    expect(SystemProjection.surfaceStateDigest(left)).not.toBe(SystemProjection.surfaceStateDigest(right))
  })

  test("seals one exact append witness for durable history and provider request assembly", () => {
    const previous: SystemSurface.Snapshot = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: sections([key("core/a"), "A"]),
    }
    const result = ready(
      [SystemSurface.present(key("core/a"), "A"), SystemSurface.present(key("core/b"), "B")],
      previous,
      [key("core/a"), key("core/b")],
    )
    const witness = SystemProjection.seal({ result, capability: capability("cumulative-privileged"), previous })

    expect(witness.plan).toEqual({ type: "append-additive", keys: [key("core/b")], text: "B" })
    expect(SystemProjection.historyText(witness)).toBe("B")
    expect(SystemProjection.headText(witness)).toBeUndefined()
    expect(SystemProjection.verify(witness, result.snapshot)).toBe(true)
  })

  test("seals exact current head bytes for a non-monotonic cumulative transition", () => {
    const previous: SystemSurface.Snapshot = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: sections([key("core/a"), "OLD"]),
    }
    const result = ready([SystemSurface.present(key("core/a"), "NEW")], previous)
    const witness = SystemProjection.seal({ result, capability: capability("cumulative-privileged"), previous })

    expect(witness.plan).toEqual({ type: "head", text: "NEW", reason: "cumulative-nonmonotonic" })
    expect(SystemProjection.headText(witness)).toBe("NEW")
    expect(SystemProjection.historyText(witness)).toBeUndefined()
  })

  test("projection identity changes when placement/capability changes even when emitted text is identical", () => {
    const previous: SystemSurface.Snapshot = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: sections([key("core/a"), "A1"]),
    }
    const result = ready([SystemSurface.present(key("core/a"), "A2")], previous)
    const head = SystemProjection.seal({ result, capability: capability("head-only"), previous })
    const appended = SystemProjection.seal({ result, capability: capability("replace-complete"), previous })

    expect(SystemSurface.render(result.snapshot)).toBe("A2")
    expect(head.digests.modelBytes).toBe(appended.digests.modelBytes)
    expect(head.digests.surfaceState).toBe(appended.digests.surfaceState)
    expect(head.digests.projection).not.toBe(appended.digests.projection)
  })

  test("verification detects tampered emitted text, capability, or checkpoint", () => {
    const result = ready([SystemSurface.present(key("core/a"), "A")])
    const witness = SystemProjection.seal({ result, capability: capability("head-only") })

    expect(SystemProjection.verify(witness, result.snapshot)).toBe(true)
    expect(
      SystemProjection.verify(
        {
          ...witness,
          plan: witness.plan.type === "head" ? { ...witness.plan, text: "tampered" } : witness.plan,
        },
        result.snapshot,
      ),
    ).toBe(false)
    expect(
      SystemProjection.verify(
        { ...witness, capability: { history: "replace-complete", turnScoped: false } },
        result.snapshot,
      ),
    ).toBe(false)
    expect(SystemProjection.verify(witness, { ...result.snapshot, projectionVersion: version(2) })).toBe(false)
  })

  test("checkpoint-only migration seals a no-op provider projection", () => {
    const previous: SystemSurface.Snapshot = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: sections([key("core/a"), "A"]),
    }
    const result = SystemSurface.reconcile(
      {
        projectionVersion: version(2),
        observations: [SystemSurface.present(key("core/a"), "A")],
      },
      previous,
    )
    expect(result._tag).toBe("Ready")
    if (result._tag !== "Ready") return

    const witness = SystemProjection.seal({ result, capability: capability("replace-complete"), previous })
    expect(witness.plan).toEqual({ type: "none", reason: "surface-unchanged" })
    expect(SystemProjection.headText(witness)).toBeUndefined()
    expect(SystemProjection.historyText(witness)).toBeUndefined()
  })
})
