import { describe, expect, test } from "bun:test"
import { DateTime, Schema } from "effect"
import { Swarm } from "../src/swarm"
import { SessionTurnProvenance } from "../src/session-turn-provenance"

describe("Swarm contracts", () => {
  test("uses disjoint canonical identifiers for aggregate and child entities", () => {
    expect(Swarm.ID.create()).toStartWith("swr_")
    expect(Swarm.MemberID.create()).toStartWith("swm_")
    expect(Swarm.TaskID.create()).toStartWith("swt_")
    expect(Swarm.TaskRunID.create()).toStartWith("swrn_")
    expect(Swarm.MessageID.create()).toStartWith("swmsg_")
    expect(Swarm.DeliveryID.create()).toStartWith("swd_")
    expect(Swarm.DeliverableID.create()).toStartWith("swdlv_")
  })

  test("omits absent nullable wire fields instead of encoding undefined", () => {
    const member = Swarm.Member.make({
      id: Swarm.MemberID.make("swm_test"),
      swarmID: Swarm.ID.make("swr_test"),
      name: "researcher",
      kind: "managed_worker",
      role: "Research",
      lifecycle: "active",
      bindingGeneration: 1,
      workspacePolicy: { mode: "shared-read" },
      time: {
        created: DateTime.makeUnsafe(0),
        updated: DateTime.makeUnsafe(0),
      },
    })
    const encoded = Schema.encodeUnknownSync(Swarm.Member)(member) as Record<string, unknown>
    expect("sessionID" in encoded).toBe(false)
    expect("desiredProfile" in encoded).toBe(false)
    expect("capabilities" in encoded).toBe(false)
  })

  test("registers Swarm conversational producers as trusted host sources with durable correlation", () => {
    for (const source of [
      SessionTurnProvenance.Source.SwarmAssignment,
      SessionTurnProvenance.Source.SwarmPeer,
      SessionTurnProvenance.Source.SwarmContinuation,
      SessionTurnProvenance.Source.SwarmRecovery,
      SessionTurnProvenance.Source.SwarmNotice,
    ]) {
      expect(SessionTurnProvenance.policy(source)?.owner).toBe("host")
      expect(SessionTurnProvenance.requiresCorrelation(source)).toBe(true)
    }
    expect(SessionTurnProvenance.policy(SessionTurnProvenance.Source.SwarmAssignment)?.workerPrompt).toBe(true)
    expect(SessionTurnProvenance.policy(SessionTurnProvenance.Source.SwarmPeer)?.workerPrompt).toBe(true)
    expect(SessionTurnProvenance.requiresCausalRoot(SessionTurnProvenance.Source.SwarmContinuation)).toBe(true)
  })
})
