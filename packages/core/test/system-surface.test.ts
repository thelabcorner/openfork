import { describe, expect, test } from "bun:test"
import { SystemSurface } from "@opencode-ai/core/system-surface"
import type { EffectiveSystemMessageCapability } from "@opencode-ai/llm"

const key = SystemSurface.Key.make
const version = SystemSurface.ProjectionVersion.make
const capability = (history: EffectiveSystemMessageCapability["history"]): EffectiveSystemMessageCapability => ({
  history,
  turnScoped: false,
})

describe("SystemSurface", () => {
  test("initializes exact rendered sections in deterministic key order", () => {
    const result = SystemSurface.reconcile({
      observations: [
        SystemSurface.present(key("core/z"), "Z"),
        SystemSurface.present(key("core/a"), "A"),
      ],
    })
    expect(result).toMatchObject({
      _tag: "Ready",
      surfaceChanged: true,
      checkpointChanged: true,
      orderChanged: false,
      snapshot: { order: ["core/a", "core/z"], sections: { "core/a": "A", "core/z": "Z" } },
    })
    if (result._tag === "Ready") expect(SystemSurface.render(result.snapshot)).toBe("A\n\nZ")
  })

  test("keeps last admitted bytes for a compatible temporarily unavailable source", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: { "core/a": "A1", "core/b": "B1" },
    }
    const result = SystemSurface.reconcile(
      {
        observations: [
          SystemSurface.present(key("core/a"), "A2"),
          SystemSurface.unavailable(key("core/b")),
        ],
      },
      previous,
    )
    expect(result).toMatchObject({
      _tag: "Ready",
      snapshot: { sections: { "core/a": "A2", "core/b": "B1" } },
      changes: [{ type: "replace", key: "core/a", rendered: "A2" }],
      surfaceChanged: true,
      checkpointChanged: true,
    })
  })

  test("distinguishes absent from unavailable", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: { "core/a": "A", "core/b": "B" },
    }
    const result = SystemSurface.reconcile(
      {
        observations: [SystemSurface.present(key("core/a"), "A"), SystemSurface.absent(key("core/b"))],
      },
      previous,
    )
    expect(result).toMatchObject({
      _tag: "Ready",
      snapshot: { order: ["core/a"], sections: { "core/a": "A" } },
      changes: [{ type: "remove", key: "core/b" }],
      surfaceChanged: true,
    })
  })

  test("blocks a newly required unavailable source but explicitly omits an optional one", () => {
    expect(
      SystemSurface.reconcile({ observations: [SystemSurface.unavailable(key("core/required"), "required")] }),
    ).toEqual({ _tag: "Blocked", keys: [key("core/required")] })

    expect(
      SystemSurface.reconcile({ observations: [SystemSurface.unavailable(key("core/optional"), "optional")] }),
    ).toMatchObject({
      _tag: "Ready",
      snapshot: { order: [], sections: {} },
      surfaceChanged: false,
      checkpointChanged: true,
    })
  })

  test("blocks required unavailable bytes across an incompatible projection version", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/remote")],
      sections: { "core/remote": "OLD" },
    }
    expect(
      SystemSurface.reconcile(
        {
          projectionVersion: version(2),
          observations: [SystemSurface.unavailable(key("core/remote"))],
        },
        previous,
      ),
    ).toEqual({ _tag: "Blocked", keys: [key("core/remote")] })
  })

  test("drops optional unavailable bytes across an incompatible projection version", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/remote")],
      sections: { "core/remote": "OLD" },
    }
    expect(
      SystemSurface.reconcile(
        {
          projectionVersion: version(2),
          observations: [SystemSurface.unavailable(key("core/remote"), "optional")],
        },
        previous,
      ),
    ).toMatchObject({
      _tag: "Ready",
      snapshot: { projectionVersion: 2, order: [], sections: {} },
      changes: [{ type: "remove", key: "core/remote" }],
      surfaceChanged: true,
    })
  })

  test("advances checkpoint version without model-visible churn when fresh bytes are identical", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: { "core/a": "SAME" },
    }
    expect(
      SystemSurface.reconcile(
        {
          projectionVersion: version(2),
          observations: [SystemSurface.present(key("core/a"), "SAME")],
        },
        previous,
      ),
    ).toMatchObject({
      _tag: "Ready",
      snapshot: { projectionVersion: 2 },
      changes: [],
      surfaceChanged: false,
      checkpointChanged: true,
    })
  })

  test("detects renderer drift directly from changed rendered bytes", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: { "core/a": "OLD same-domain-value" },
    }
    expect(
      SystemSurface.reconcile(
        { observations: [SystemSurface.present(key("core/a"), "NEW same-domain-value")] },
        previous,
      ),
    ).toMatchObject({
      _tag: "Ready",
      changes: [{ type: "replace", key: "core/a", rendered: "NEW same-domain-value" }],
      surfaceChanged: true,
    })
  })

  test("detects semantic reordering separately from section replacement", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: { "core/a": "A", "core/b": "B" },
    }
    expect(
      SystemSurface.reconcile(
        {
          observations: [SystemSurface.present(key("core/a"), "A"), SystemSurface.present(key("core/b"), "B")],
          order: [key("core/b"), key("core/a")],
        },
        previous,
      ),
    ).toMatchObject({
      _tag: "Ready",
      changes: [],
      surfaceChanged: true,
      checkpointChanged: true,
      orderChanged: true,
    })
  })

  test("treats an omitted previously admitted key as removal", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: { "core/a": "A", "core/b": "B" },
    }
    expect(
      SystemSurface.reconcile({ observations: [SystemSurface.present(key("core/a"), "A")] }, previous),
    ).toMatchObject({
      _tag: "Ready",
      changes: [{ type: "remove", key: "core/b" }],
      surfaceChanged: true,
    })
  })

  test("rejects duplicate observation keys and invalid explicit order", () => {
    expect(() =>
      SystemSurface.reconcile({
        observations: [SystemSurface.present(key("core/a"), "A"), SystemSurface.present(key("core/a"), "B")],
      }),
    ).toThrow(SystemSurface.DuplicateKeyError)

    expect(() =>
      SystemSurface.reconcile({
        observations: [SystemSurface.present(key("core/a"), "A"), SystemSurface.present(key("core/b"), "B")],
        order: [key("core/a")],
      }),
    ).toThrow(SystemSurface.InvalidOrderError)
  })

  test("rejects empty present text so absence is explicit", () => {
    expect(() => SystemSurface.reconcile({ observations: [SystemSurface.present(key("core/a"), "")] })).toThrow(
      SystemSurface.EmptySectionError,
    )
  })

  test("plans the initial semantic surface at the privileged head regardless of later-message capability", () => {
    const ready = SystemSurface.reconcile({ observations: [SystemSurface.present(key("core/a"), "A")] })
    expect(ready._tag).toBe("Ready")
    if (ready._tag !== "Ready") return

    expect(SystemSurface.planProjection(ready, capability("cumulative-privileged"))).toEqual({
      type: "head",
      text: "A",
      reason: "initial",
    })
  })

  test("does not project checkpoint-only changes", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: { "core/a": "A" },
    }
    const ready = SystemSurface.reconcile(
      { projectionVersion: version(2), observations: [SystemSurface.present(key("core/a"), "A")] },
      previous,
    )
    expect(ready._tag).toBe("Ready")
    if (ready._tag !== "Ready") return

    expect(SystemSurface.planProjection(ready, capability("replace-complete"), previous)).toEqual({
      type: "none",
      reason: "surface-unchanged",
    })
  })

  test("projects changed state at the head for head-only capability", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: { "core/a": "A1" },
    }
    const ready = SystemSurface.reconcile(
      { observations: [SystemSurface.present(key("core/a"), "A2")] },
      previous,
    )
    expect(ready._tag).toBe("Ready")
    if (ready._tag !== "Ready") return

    expect(SystemSurface.planProjection(ready, capability("head-only"), previous)).toEqual({
      type: "head",
      text: "A2",
      reason: "head-only",
    })
  })

  test("appends the complete current surface only for replace-complete capability", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a")],
      sections: { "core/a": "A1" },
    }
    const ready = SystemSurface.reconcile(
      { observations: [SystemSurface.present(key("core/a"), "A2")] },
      previous,
    )
    expect(ready._tag).toBe("Ready")
    if (ready._tag !== "Ready") return

    expect(SystemSurface.planProjection(ready, capability("replace-complete"), previous)).toEqual({
      type: "append-complete",
      text: "A2",
    })
  })

  test("uses cumulative append only for exact suffix additions", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: { "core/a": "A", "core/b": "B" },
    }
    const ready = SystemSurface.reconcile(
      {
        observations: [
          SystemSurface.present(key("core/a"), "A"),
          SystemSurface.present(key("core/b"), "B"),
          SystemSurface.present(key("core/c"), "C"),
        ],
        order: [key("core/a"), key("core/b"), key("core/c")],
      },
      previous,
    )
    expect(ready._tag).toBe("Ready")
    if (ready._tag !== "Ready") return

    expect(SystemSurface.planProjection(ready, capability("cumulative-privileged"), previous)).toEqual({
      type: "append-additive",
      keys: [key("core/c")],
      text: "C",
    })
  })

  test("falls back to head when a cumulative addition would be inserted before prior state", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/b")],
      sections: { "core/b": "B" },
    }
    const ready = SystemSurface.reconcile(
      {
        observations: [SystemSurface.present(key("core/a"), "A"), SystemSurface.present(key("core/b"), "B")],
        order: [key("core/a"), key("core/b")],
      },
      previous,
    )
    expect(ready._tag).toBe("Ready")
    if (ready._tag !== "Ready") return

    expect(SystemSurface.planProjection(ready, capability("cumulative-privileged"), previous)).toEqual({
      type: "head",
      text: "A\n\nB",
      reason: "cumulative-nonmonotonic",
    })
  })

  test("falls back to head for cumulative replacement and removal", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: { "core/a": "A1", "core/b": "B" },
    }
    const replaced = SystemSurface.reconcile(
      { observations: [SystemSurface.present(key("core/a"), "A2"), SystemSurface.present(key("core/b"), "B")] },
      previous,
    )
    const removed = SystemSurface.reconcile(
      { observations: [SystemSurface.present(key("core/a"), "A1")] },
      previous,
    )
    expect(replaced._tag).toBe("Ready")
    expect(removed._tag).toBe("Ready")
    if (replaced._tag !== "Ready" || removed._tag !== "Ready") return

    expect(SystemSurface.planProjection(replaced, capability("cumulative-privileged"), previous)).toMatchObject({
      type: "head",
      reason: "cumulative-nonmonotonic",
    })
    expect(SystemSurface.planProjection(removed, capability("cumulative-privileged"), previous)).toMatchObject({
      type: "head",
      reason: "cumulative-nonmonotonic",
    })
  })

  test("falls back to head for cumulative semantic reordering", () => {
    const previous = {
      projectionVersion: version(1),
      order: [key("core/a"), key("core/b")],
      sections: { "core/a": "A", "core/b": "B" },
    }
    const ready = SystemSurface.reconcile(
      {
        observations: [SystemSurface.present(key("core/a"), "A"), SystemSurface.present(key("core/b"), "B")],
        order: [key("core/b"), key("core/a")],
      },
      previous,
    )
    expect(ready._tag).toBe("Ready")
    if (ready._tag !== "Ready") return

    expect(SystemSurface.planProjection(ready, capability("cumulative-privileged"), previous)).toEqual({
      type: "head",
      text: "B\n\nA",
      reason: "cumulative-order-change",
    })
  })
})
