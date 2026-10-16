import { describe, expect, test } from "bun:test"
import MEMBER_DESCRIPTION from "../../src/tool/swarm-member.txt"
import SWARM_DESCRIPTION from "../../src/tool/swarm.txt"
import { Parameters } from "../../src/tool/swarm-member"
import { ToolJsonSchema } from "../../src/tool/json-schema"

// Assert against the provider-visible manifest, not the internal schema object:
// these descriptions are exactly the text the model reads.
const manifest = ToolJsonSchema.fromSchema(Parameters as never) as Record<string, any>
const fieldDescription = (name: string) => String(manifest.properties?.[name]?.description ?? "")

const ACTION = fieldDescription("action")
const TO = fieldDescription("to")

describe("swarm worker protocol naming", () => {
  test("every model-facing swarm surface names the exact 'Swarm member' channel", () => {
    expect(MEMBER_DESCRIPTION).toContain("mail a Swarm member")
    expect(ACTION).toContain("send=Swarm member mail")
    expect(ACTION).toContain("inbox=read Swarm member mail")
    expect(TO).toContain("Swarm member roster name")
    expect(SWARM_DESCRIPTION).toContain("Swarm member message bodies")
  })

  test("no swarm surface keeps a bare 'peer' that reads as an OFXP remote machine", () => {
    // 'peer' alone is ambiguous in OpenFork: an OFXP peer is a remote machine.
    for (const prose of [MEMBER_DESCRIPTION, SWARM_DESCRIPTION, ACTION, TO]) {
      expect(prose).not.toContain("peer mail")
      expect(prose).not.toContain("peer member")
      expect(prose).not.toContain("mail a peer")
      expect(prose).not.toContain("Peer message bodies")
    }
  })

  test("the OFXP cross-reference uses the exact connector label and stays non-authoritative", () => {
    expect(MEMBER_DESCRIPTION).toContain("An OFXP peer is a different thing")
    expect(MEMBER_DESCRIPTION).toContain("`ofxp`")
    expect(MEMBER_DESCRIPTION).toContain("`peerID`")
    // Disambiguation is naming only: a label must never read as a grant.
    expect(MEMBER_DESCRIPTION).toContain("never grants membership, trust, or authority")
    expect(MEMBER_DESCRIPTION).toContain("only the host resolves those")
  })

  test("worker protocol prose leaks no local-only identifiers", () => {
    for (const prose of [MEMBER_DESCRIPTION, SWARM_DESCRIPTION]) {
      expect(prose).not.toMatch(/[A-Za-z]:[\\/]/)
      expect(prose).not.toContain("file://")
      expect(prose).not.toContain("localhost")
      expect(prose).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    }
  })
})
