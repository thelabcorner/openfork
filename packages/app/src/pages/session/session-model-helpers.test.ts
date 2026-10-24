import { describe, expect, test } from "bun:test"
import type { UserMessage } from "@opencode-ai/sdk/v2"
import { resetSessionModel, restorePromptModel, syncPromptModel, syncSessionModel } from "./session-model-helpers"

const message = (input?: { agent?: string; model?: UserMessage["model"] }) =>
  ({
    id: "msg",
    sessionID: "session",
    role: "user",
    time: { created: 1 },
    agent: input?.agent ?? "build",
    model: input?.model ?? { providerID: "anthropic", modelID: "claude-sonnet-4" },
  }) as UserMessage

describe("syncSessionModel", () => {
  test("restores the last message through session state", () => {
    const calls: unknown[] = []

    syncSessionModel(
      {
        session: {
          restore(value) {
            calls.push(value)
          },
          reset() {},
        },
      },
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    )

    expect(calls).toEqual([
      message({ model: { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" } }),
    ])
  })
})

describe("resetSessionModel", () => {
  test("clears draft session state", () => {
    const calls: string[] = []

    resetSessionModel({
      session: {
        reset() {
          calls.push("reset")
        },
        restore() {},
      },
    })

    expect(calls).toEqual(["reset"])
  })
})

describe("syncPromptModel", () => {
  test("stores the effective session model in prompt state", () => {
    const calls: unknown[] = []

    syncPromptModel(
      {
        model: {
          current: () => ({ id: "claude-sonnet-4", provider: { id: "anthropic" } }),
          set() {},
          variant: { current: () => "high", set() {} },
        },
      },
      {
        model: {
          current: () => undefined,
          set: (model) => calls.push(model),
        },
      },
    )

    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }])
  })

  test("does not rewrite an unchanged prompt model", () => {
    const calls: unknown[] = []
    const model = { providerID: "anthropic", modelID: "claude-sonnet-4", variant: "high" }

    syncPromptModel(
      {
        model: {
          current: () => ({ id: model.modelID, provider: { id: model.providerID } }),
          set() {},
          variant: { current: () => model.variant, set() {} },
        },
      },
      {
        model: {
          current: () => model,
          set: (value) => calls.push(value),
        },
      },
    )

    expect(calls).toEqual([])
  })
})

describe("hosted account strategy synchronization", () => {
  test("an unqualified legacy account selection means Adaptive, not an additional routing strategy", () => {
    const calls: unknown[] = []
    const local = {
      model: {
        current: () => ({ id: "hosted-model", provider: { id: "opencode-go" } }),
        routeIntent: { current: () => ({ kind: "strategy" as const }) },
        set() {},
        variant: { current: () => undefined, set() {} },
      },
    }
    const prompt = (strategy: "adaptive" | "round-robin") => ({
      model: {
        current: () => ({
          providerID: "opencode-go",
          modelID: "hosted-model",
          routeIntent: { kind: "strategy" as const, strategy },
        }),
        set: (value: unknown) => calls.push(value),
      },
    })
    syncPromptModel(local, prompt("adaptive"))
    expect(calls).toHaveLength(0)
    syncPromptModel(local, prompt("round-robin"))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ routeIntent: { kind: "strategy" } })
  })

  test("a hosted legacy missing intent and Adaptive selection do not rewrite each other", () => {
    const calls: unknown[] = []
    syncPromptModel({
      model: {
        current: () => ({ id: "model", provider: { id: "opencode-go" } }),
        routeIntent: { current: () => undefined },
        set() {},
        variant: { current: () => undefined, set() {} },
      },
    }, {
      model: {
        current: () => ({
          providerID: "opencode-go",
          modelID: "model",
          routeIntent: { kind: "strategy", strategy: "adaptive" },
        }),
        set: (model) => calls.push(model),
      },
    })
    expect(calls).toHaveLength(0)

    const restored = restorePromptModel({
      model: {
        current: () => ({ id: "model", provider: { id: "opencode" } }),
        routeIntent: { current: () => ({ kind: "strategy" as const, strategy: "adaptive" as const }) },
        set: (model) => calls.push(model),
        variant: { current: () => undefined, set: (variant) => calls.push(variant) },
      },
    }, {
      model: {
        current: () => ({ providerID: "opencode", modelID: "model" }),
        set() {},
      },
    })
    expect(restored).toBe(true)
    expect(calls).toHaveLength(0)
  })

  test("missing intent must not erase an explicit Round Robin or Public selection", () => {
    for (const intent of [{ kind: "strategy" as const, strategy: "round-robin" as const }, { kind: "public" as const }]) {
      const calls: unknown[] = []
      syncPromptModel({
        model: {
          current: () => ({ id: "model", provider: { id: "opencode" } }),
          routeIntent: { current: () => undefined },
          set() {},
          variant: { current: () => undefined, set() {} },
        },
      }, {
        model: {
          current: () => ({ providerID: "opencode", modelID: "model", routeIntent: intent }),
          set: (model) => calls.push(model),
        },
      })
      expect(calls).toHaveLength(1)
    }
  })
})

describe("restorePromptModel", () => {
  test("restores the persisted prompt model into session selection", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => ({ providerID: "anthropic", modelID: "claude", variant: "high" }),
          set() {},
        },
      },
    )

    expect(restored).toBe(true)
    expect(calls).toEqual([{ providerID: "anthropic", modelID: "claude" }, "high"])
  })

  test("does nothing without a persisted prompt model", () => {
    const calls: unknown[] = []
    const restored = restorePromptModel(
      {
        model: {
          current: () => ({ id: "gpt", provider: { id: "openai" } }),
          set: (model) => calls.push(model),
          variant: {
            current: () => undefined,
            set: (variant) => calls.push(variant),
          },
        },
      },
      {
        model: {
          current: () => undefined,
          set() {},
        },
      },
    )

    expect(restored).toBe(false)
    expect(calls).toEqual([])
  })
})
