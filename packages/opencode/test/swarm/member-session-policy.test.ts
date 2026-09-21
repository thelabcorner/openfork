import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode-ai/schema/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Swarm } from "@opencode-ai/schema/swarm"
import { Provider } from "@/provider/provider"
import {
  effectiveBoundary,
  sessionIDForBinding,
  unsupportedCapabilities,
  worktreeNameForMember,
} from "@/swarm/member-session"

const profile = Swarm.MemberExecutionProfile.make({
  agent: Agent.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("model"),
  },
  permissionBoundary: [{ action: "webfetch", resource: "*", effect: "ask" }],
})

describe("Swarm managed-member policy", () => {
  test("derives a stable Session identity from member + binding generation", () => {
    const member = Swarm.MemberID.make("swm_member_a")
    expect(sessionIDForBinding(member, 1)).toBe(sessionIDForBinding(member, 1))
    expect(sessionIDForBinding(member, 1)).not.toBe(sessionIDForBinding(member, 2))
    expect(worktreeNameForMember(member)).toBe("swarm-swm_member_a")
  })

  test("shared-read narrows writes without mutating the durable desired boundary", () => {
    const narrowed = effectiveBoundary(profile, { mode: "shared-read" })
    expect(narrowed).toEqual([
      { action: "webfetch", resource: "*", effect: "ask" },
      { action: "edit", resource: "*", effect: "deny" },
      { action: "bash", resource: "*", effect: "deny" },
    ])
    expect(profile.permissionBoundary).toEqual([{ action: "webfetch", resource: "*", effect: "ask" }])
    expect(effectiveBoundary(profile, { mode: "shared-write" })).toEqual([...profile.permissionBoundary])
  })

  test("capability validation fails closed for unknown or unsupported requests", () => {
    const model = {
      capabilities: {
        toolcall: true,
        reasoning: false,
        attachment: true,
        temperature: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
    } as Provider.Model

    expect(unsupportedCapabilities(model, ["tools", "image", "pdf", "output:text"])).toEqual([])
    expect(unsupportedCapabilities(model, ["reasoning", "output:image", "future-capability"])).toEqual([
      "reasoning",
      "output:image",
      "future-capability",
    ])
  })
})
