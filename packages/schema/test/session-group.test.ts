import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { SessionGroup } from "../src/session-group"
import { SwarmID } from "../src/swarm-id"

describe("SessionGroup first-party structural kinds", () => {
  test("exposes Swarm groups only on the read-model kind", () => {
    expect(Schema.decodeUnknownSync(SessionGroup.Kind)("swarm")).toBe("swarm")
    expect(Schema.decodeUnknownSync(SessionGroup.Kind)("delegation")).toBe("delegation")
    expect(() => Schema.decodeUnknownSync(SessionGroup.MutableKind)("swarm")).toThrow()
  })

  test("exposes Swarm member origin only on the read-model origin", () => {
    expect(Schema.decodeUnknownSync(SessionGroup.MemberOrigin)("swarm")).toBe("swarm")
    expect(Schema.decodeUnknownSync(SessionGroup.MemberOrigin)("delegation")).toBe("delegation")
    expect(() => Schema.decodeUnknownSync(SessionGroup.MutableMemberOrigin)("swarm")).toThrow()
  })

  test("maps Swarm identity to one reversible collision-free virtual group id", () => {
    const swarm = SwarmID.make("swr_01testopaque")
    const group = SessionGroup.groupIDForSwarm(swarm)

    expect(group).toBe(SessionGroup.ID.make("grp_swarm_01testopaque"))
    expect(SessionGroup.isSwarmGroupID(group)).toBe(true)
    expect(SessionGroup.swarmIDFromGroupID(group)).toBe(swarm)
    expect(SessionGroup.swarmIDFromGroupID(SessionGroup.ID.make("grp_regular"))).toBeUndefined()
  })
})
