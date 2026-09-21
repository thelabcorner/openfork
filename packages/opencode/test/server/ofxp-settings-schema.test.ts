import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { OfxpSettingsState } from "../../src/server/routes/instance/httpapi/groups/ofxp"

const peerID = Ofxp.PeerID.make(`ofxp_${"A".repeat(43)}`)

function stateWithActivity(count: number) {
  return {
    status: { active: false, discovery: "disabled" as const },
    candidates: [],
    pairings: [],
    peers: [],
    activity: Array.from({ length: count }, (_, index) => ({
      sourcePeerID: peerID,
      operation: "read",
      commitClass: "safe_read" as const,
      state: "committed" as const,
      createdAt: index,
      settledAt: index + 1,
    })),
  }
}

test("OFXP settings activity cardinality matches the 256-peer producer ceiling", () => {
  const decode = Schema.decodeUnknownSync(OfxpSettingsState)
  expect(() => decode(stateWithActivity(256))).not.toThrow()
  expect(() => decode(stateWithActivity(257))).toThrow()
})
