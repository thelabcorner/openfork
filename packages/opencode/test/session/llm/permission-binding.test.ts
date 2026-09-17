import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { it } from "../../lib/effect"
import { EffectBridge } from "@/effect/bridge"
import { InstanceState } from "@/effect/instance-state"
import { SessionID } from "@/session/schema"
import { bindPermission, type Askable } from "@/session/llm/permission-binding"

// Stand-in for Permission.Service.ask: it reads per-directory instance state,
// which is exactly what dies when the effect runs without an InstanceRef.
const readDirectory: Askable = {
  ask: () => InstanceState.directory.pipe(Effect.asVoid),
}

const input: PermissionV1.AskInput = {
  id: PermissionV1.ID.ascending(),
  sessionID: SessionID.make("ses_permission-binding"),
  permission: "test",
  patterns: ["*"],
  metadata: {},
  always: ["*"],
  ruleset: [],
}

describe("session.llm.permission-binding", () => {
  it.instance("runs a permission ask with the captured instance context", () =>
    Effect.gen(function* () {
      const bridge = yield* EffectBridge.make()
      const bound = bindPermission(readDirectory, bridge)

      // Regression guard: a bare runPromise has no InstanceRef, so the ask
      // dies before evaluating any ruleset and callers would misread it as a
      // denial.
      const bare = yield* Effect.promise(() =>
        Effect.runPromise(readDirectory.ask(input)).then(
          () => "resolved",
          () => "died",
        ),
      )
      expect(bare).toBe("died")

      const viaBound = yield* Effect.promise(() =>
        Effect.runPromise(bound.ask(input)).then(
          () => "resolved",
          () => "died",
        ),
      )
      expect(viaBound).toBe("resolved")
    }),
  )
})
