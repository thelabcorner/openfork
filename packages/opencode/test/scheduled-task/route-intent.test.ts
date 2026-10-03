import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ScheduledTaskRouteIntent } from "@/scheduled-task/route-intent"
import { Model } from "@opencode-ai/schema/model"
import { Provider } from "@opencode-ai/schema/provider"
import { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { ScheduledTask } from "@opencode-ai/schema/scheduled-task"

const model = (accountID?: string): Model.Ref => ({
  id: Model.ID.make("space-bunny-free"),
  providerID: Provider.ID.make("opencode"),
  ...(accountID ? { accountID } : {}),
})

const action = (input: {
  routeIntent?: ProviderRouteIntent.Info
  accountID?: string
} = {}): ScheduledTask.Action =>
  ScheduledTask.Action.make({
    prompt: "run",
    model: model(input.accountID),
    ...(input.routeIntent === undefined ? {} : { routeIntent: input.routeIntent }),
  })

const outcome = (value: ScheduledTask.Action) =>
  Effect.runSync(
    ScheduledTaskRouteIntent.normalizeAction(value).pipe(
      Effect.map((routeIntent) => ({ ok: true as const, routeIntent })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    ),
  )

describe("ScheduledTaskRouteIntent.normalizeAction", () => {
  test("preserves absence when the task made no route choice", () => {
    const result = outcome(ScheduledTask.Action.make({ prompt: "run" }))
    expect(result).toEqual({ ok: true, routeIntent: undefined })
  })

  test("projects legacy model.accountID into a durable hard account intent", () => {
    const result = outcome(action({ accountID: "acct-a" }))
    expect(result).toEqual({
      ok: true,
      routeIntent: { kind: "account", accountID: "acct-a", pin: "hard" },
    })
  })

  test("carries explicit Auto durably without inventing an account identity", () => {
    const result = outcome(action({ routeIntent: ProviderRouteIntent.Info.make({ kind: "auto" }) }))
    expect(result).toEqual({ ok: true, routeIntent: { kind: "auto" } })
  })

  test("carries explicit Public durably for SessionPrompt/P5A binding", () => {
    const result = outcome(action({ routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }) }))
    expect(result).toEqual({ ok: true, routeIntent: { kind: "public" } })
  })

  test("carries an explicit account route durably for exact P5A binding", () => {
    const result = outcome(
      action({
        routeIntent: ProviderRouteIntent.Info.make({
          kind: "account",
          accountID: "acct-a",
          pin: "soft",
        }),
      }),
    )
    expect(result).toEqual({
      ok: true,
      routeIntent: { kind: "account", accountID: "acct-a", pin: "soft" },
    })
  })

  test("rejects legacy account identity combined with explicit Public before dispatch", () => {
    const result = outcome(
      action({
        accountID: "acct-a",
        routeIntent: ProviderRouteIntent.Info.make({ kind: "public" }),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error._tag).toBe("ProviderRouteIntent.Conflict")
    if (result.error._tag === "ProviderRouteIntent.Conflict") {
      expect(result.error.legacyAccountID).toBe("acct-a")
      expect(result.error.routeKind).toBe("public")
    }
  })

  test("rejects conflicting legacy and explicit account identities before dispatch", () => {
    const result = outcome(
      action({
        accountID: "acct-a",
        routeIntent: ProviderRouteIntent.Info.make({
          kind: "account",
          accountID: "acct-b",
          pin: "hard",
        }),
      }),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error._tag).toBe("ProviderRouteIntent.Conflict")
    if (result.error._tag === "ProviderRouteIntent.Conflict") {
      expect(result.error.legacyAccountID).toBe("acct-a")
      expect(result.error.routeAccountID).toBe("acct-b")
    }
  })
})
