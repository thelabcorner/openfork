import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { EventManifest } from "../src/event-manifest"
import { SessionLimitRecovery } from "../src/session-limit-recovery"
import { SessionID } from "../src/session-id"

describe("SessionLimitRecovery event contracts", () => {
  test("publishes the fork-owned update and clear events in both manifests", () => {
    expect(SessionLimitRecovery.Definitions.map((definition) => definition.type)).toEqual([
      "session.limit_recovery.updated",
      "session.limit_recovery.cleared",
    ])
    for (const definition of SessionLimitRecovery.Definitions) {
      expect(EventManifest.Latest.has(definition.type)).toBe(true)
      expect(EventManifest.ServerDefinitions.some((entry) => entry.type === definition.type)).toBe(true)
    }

    const cleared = Schema.decodeUnknownSync(SessionLimitRecovery.Cleared.data)({ sessionID: "ses_recovery", generation: 3 })
    expect(cleared.sessionID).toBe(SessionID.make("ses_recovery"))
    expect(cleared.generation).toBe(3)
  })
})
