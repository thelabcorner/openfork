import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmMemberTable, SwarmTable } from "@opencode-ai/core/swarm/sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { Swarm } from "@opencode-ai/schema/swarm"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SwarmV2.node])))

const projectID = ProjectV2.ID.make("swarm-legacy-profile-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_legacy_profile")
const directory = "/swarm/legacy-profile"

/**
 * A historical row exactly as the preflight-hardening database contained them:
 * one real runtime requirement ("tools"), one legacy alias spelling
 * ("input:image"), and two semantic routing tags a coordinator invented.
 * `research`/`audit` were checked against the provider catalog and can never be
 * satisfied, which is what left those workers permanently unbound.
 */
const legacyProfile = {
  ...managedProfile,
  requestedCapabilities: ["tools", "input:image", "research", "audit"],
} as unknown as Swarm.MemberExecutionProfile

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make(directory), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "Swarm legacy profile", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
})

const insertLegacySwarm = Effect.fn("test.insertLegacySwarm")(function* (
  memberID: Swarm.MemberID,
  name: string,
  profile: Swarm.MemberExecutionProfile,
) {
  const swarms = yield* SwarmV2.Service
  const swarm = yield* swarms.create({ projectID, workspaceID, directory, name, now: 100 })
  const { db } = yield* Database.Service
  yield* db
    .insert(SwarmMemberTable)
    .values({
      id: memberID,
      swarm_id: swarm.id,
      name,
      kind: "managed_worker",
      role: "Research",
      lifecycle: "active",
      binding_generation: 0,
      // Written straight to the durable column, bypassing every current
      // contract, so the read path must cope with pre-rename bytes.
      desired_profile: profile,
      workspace_policy: { mode: "shared-read" },
      capabilities: { tags: [] },
      time_created: 101,
      time_updated: 101,
    })
    .run()
    .pipe(Effect.orDie)
  return swarm
})

describe("Swarm legacy desired_profile compatibility", () => {
  it.effect("reads a persisted legacy profile as canonical modelRequirements", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const memberID = Swarm.MemberID.create()
      const swarm = yield* insertLegacySwarm(memberID, "legacy-worker", legacyProfile)

      const detail = yield* swarms.get(swarm.id)
      const member = detail.members.find((row) => row.id === memberID)!
      const profile = member.desiredProfile!

      // Real runtime requirements survive the rename, normalized to the closed
      // vocabulary, so a genuinely capable model still passes preflight.
      expect([...(profile.modelRequirements ?? [])].sort()).toEqual(["input_image", "toolcall"])

      // The retired key is gone from the contract, so nothing downstream can
      // read it as a requirement.
      expect("requestedCapabilities" in (profile as object)).toBe(false)

      // Semantic routing tags are reported for operator visibility and are NOT
      // turned into requirements. `unproven` stays empty, which is precisely
      // what keeps this worker materializable instead of stranded.
      expect(member.capabilities?.legacyRoutingTags?.slice().sort()).toEqual(["audit", "research"])
      expect(member.capabilities?.legacyUnprovenRequirements).toBeUndefined()
      expect(profile.modelRequirements ?? []).not.toContain("research")
    }),
  )

  it.effect("keeps the normalized profile decodable by the current contract", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const memberID = Swarm.MemberID.create()
      const swarm = yield* insertLegacySwarm(memberID, "legacy-decodable", legacyProfile)

      const detail = yield* swarms.get(swarm.id)
      const member = detail.members.find((row) => row.id === memberID)!

      // The normalized profile must satisfy the public contract on its own; a
      // legacy row may not become a decode failure for any later consumer.
      const decoded = Schema.decodeUnknownSync(Swarm.MemberExecutionProfile)(member.desiredProfile)
      expect(decoded.modelRequirements).toEqual(["toolcall", "input_image"])
    }),
  )

  it.effect("is deterministic and idempotent across repeated reads", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const memberID = Swarm.MemberID.create()
      const swarm = yield* insertLegacySwarm(memberID, "legacy-stable", legacyProfile)

      const first = (yield* swarms.get(swarm.id)).members.find((row) => row.id === memberID)!
      const second = (yield* swarms.get(swarm.id)).members.find((row) => row.id === memberID)!

      expect(second.desiredProfile).toEqual(first.desiredProfile)
      expect(second.capabilities).toEqual(first.capabilities)
    }),
  )

  it.effect("quarantines an unprovable legacy requirement instead of dropping it", () =>
    Effect.gen(function* () {
      yield* setup
      const swarms = yield* SwarmV2.Service
      const memberID = Swarm.MemberID.create()
      const swarm = yield* insertLegacySwarm(memberID, "legacy-unproven", {
        ...managedProfile,
        requestedCapabilities: ["retina-vision"],
      } as unknown as Swarm.MemberExecutionProfile)

      const detail = yield* swarms.get(swarm.id)
      const member = detail.members.find((row) => row.id === memberID)!

      // Deterministic and visible: the member is quarantined fail-closed rather
      // than silently running against a model that may not satisfy the original
      // constraint. The value is preserved verbatim, not normalized away.
      expect(member.capabilities?.legacyUnprovenRequirements).toEqual([
        '"retina-vision" is not a known model requirement and cannot be proven against the model catalog',
      ])
      expect(member.capabilities?.legacyRoutingTags).toBeUndefined()
      expect(member.desiredProfile?.modelRequirements).toBeUndefined()
    }),
  )

  it.effect("never writes the retired key back to the durable column", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const swarms = yield* SwarmV2.Service
      const memberID = Swarm.MemberID.create()
      const swarm = yield* insertLegacySwarm(memberID, "legacy-roundtrip", legacyProfile)

      // Read-modify-write through the normal member update path.
      const detail = yield* swarms.get(swarm.id)
      const member = detail.members.find((row) => row.id === memberID)!
      // Reconfiguration is a fenced mutation that requires a stopped member.
      // `stop` also advances the binding fence, so the reconfigure must be
      // written against the post-stop generation, never the pre-stop one.
      const stopped = yield* swarms.setMemberLifecycle({
        swarmID: swarm.id,
        memberID,
        expectedLifecycle: member.lifecycle,
        lifecycle: "stopped",
      })
      yield* swarms.configureMember({
        swarmID: swarm.id,
        memberID,
        expectedBindingGeneration: stopped.bindingGeneration,
        desiredProfile: { ...managedProfile, modelRequirements: ["toolcall"] },
        workspacePolicy: member.workspacePolicy,
        capabilities: { tags: ["typescript"] },
      })

      const rows = (yield* db
        .select({ desired_profile: SwarmMemberTable.desired_profile })
        .from(SwarmMemberTable)
        .run()
        .pipe(Effect.orDie)) as ReadonlyArray<{ desired_profile: unknown }>
      // The JSON column may surface either parsed or raw depending on the driver
      // path, so read the stored bytes through one parser.
      const raw = rows[0]?.desired_profile
      const stored = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, unknown> | undefined
      expect(stored === undefined || typeof stored === "object").toBe(true)
      expect(stored === undefined || "requestedCapabilities" in stored).toBe(false)
      expect(stored?.modelRequirements).toEqual(["toolcall"])
    }),
  )
})