import { describe, expect, test } from "bun:test"
import { SwarmMemberTable } from "@opencode-ai/core/swarm/sql"
import { hydrateMember } from "@opencode-ai/core/swarm/projection"

const row = (desiredProfile: unknown, capabilities: unknown) =>
  ({
    id: "swm_projection",
    swarm_id: "swr_projection",
    name: "researcher",
    kind: "managed_worker",
    role: "researcher",
    lifecycle: "active",
    session_id: null,
    binding_generation: 0,
    desired_profile: desiredProfile,
    workspace_policy: { mode: "shared-read" },
    capabilities,
    time_created: 1,
    time_updated: 1,
    time_stopped: null,
  }) as unknown as typeof SwarmMemberTable.$inferSelect

const stored = (requestedCapabilities: string[]) => ({
  agent: "build",
  model: { providerID: "anthropic", id: "claude-opus-5" },
  permissionBoundary: [],
  requestedCapabilities,
})

describe("hydrateMember legacy execution-profile compatibility", () => {
  test("migrates recognized runtime aliases and drops the retired key", () => {
    const member = hydrateMember(row(stored(["tools", "input:image", "output:text"]), null))
    expect([...(member.desiredProfile?.modelRequirements ?? [])].sort()).toEqual([
      "input_image",
      "output_text",
      "toolcall",
    ])
    expect("requestedCapabilities" in (member.desiredProfile as object)).toBe(false)
    expect(member.capabilities?.legacyUnprovenRequirements).toBeUndefined()
  })

  test("reports semantic routing tags without inventing a requirement", () => {
    const member = hydrateMember(row(stored(["research", "audit"]), null))
    expect(member.desiredProfile?.modelRequirements).toBeUndefined()
    expect([...(member.capabilities?.legacyRoutingTags ?? [])].sort()).toEqual(["audit", "research"])
    expect(member.capabilities?.legacyUnprovenRequirements).toBeUndefined()
  })

  test("surfaces an unrecognized legacy requirement as a fail-closed signal", () => {
    const member = hydrateMember(row(stored(["tools", "telepathy"]), null))
    expect(member.desiredProfile?.modelRequirements).toEqual(["toolcall"])
    expect(member.capabilities?.legacyUnprovenRequirements).toHaveLength(1)
    expect(member.capabilities?.legacyUnprovenRequirements?.[0]).toContain("telepathy")
  })

  test("preserves existing member tags while attaching the compatibility report", () => {
    const member = hydrateMember(row(stored(["audit"]), { tags: ["typescript"] }))
    expect(member.capabilities?.tags).toEqual(["typescript"])
    expect(member.capabilities?.legacyRoutingTags).toEqual(["audit"])
  })

  test("leaves already-migrated rows untouched", () => {
    const member = hydrateMember(
      row(
        {
          agent: "build",
          model: { providerID: "anthropic", id: "claude-opus-5" },
          permissionBoundary: [],
          modelRequirements: ["toolcall", "reasoning"],
        },
        null,
      ),
    )
    expect(member.desiredProfile?.modelRequirements).toEqual(["toolcall", "reasoning"])
    expect(member.capabilities).toBeUndefined()
  })
})