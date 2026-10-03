import { describe, expect } from "bun:test"
import { DateTime, Effect, Layer } from "effect"
import { Agent as AgentModel } from "@opencode-ai/schema/agent"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecutionBoundary } from "@opencode-ai/core/session/execution-boundary"
import { Database } from "@opencode-ai/core/database/database"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { Swarm } from "@opencode-ai/schema/swarm"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Session } from "@/session/session"
import { Worktree } from "@/worktree"
import { Git } from "@/git"
import { SwarmMemberSession } from "@/swarm/member-session"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { testEffect } from "../lib/effect"

const projectID = ProjectV2.ID.make("swarm-member-session-project")
const swarmID = Swarm.ID.make("swr_member_session")
const memberID = Swarm.MemberID.make("swm_member_session")
const profile = Swarm.MemberExecutionProfile.make({
  agent: AgentModel.ID.make("build"),
  model: {
    providerID: ProviderV2.ID.make("test"),
    id: ModelV2.ID.make("test-model"),
    variant: ModelV2.VariantID.make("high"),
  },
  permissionBoundary: [{ action: "webfetch", resource: "*", effect: "ask" }],
  modelRequirements: ["toolcall", "input_image"],
})

let member: Swarm.Member
let sessions = new Map<string, SessionV2.Info>()
let boundaries = new Map<string, unknown>()
let order: string[] = []

function reset() {
  sessions = new Map()
  boundaries = new Map()
  order = []
  member = Swarm.Member.make({
    id: memberID,
    swarmID,
    name: "researcher",
    kind: "managed_worker",
    role: "researcher",
    lifecycle: "active",
    bindingGeneration: 0,
    desiredProfile: profile,
    workspacePolicy: { mode: "shared-read" },
    time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
  })
}

const swarm = Swarm.Info.make({
  id: swarmID,
  projectID,
  directory: "/swarm/project",
  name: "native swarm",
  status: "active",
  policy: Swarm.Policy.make({}),
  revision: 0,
  time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
})

const swarmMock = Layer.mock(SwarmV2.Service, {
  memberSessionTarget: () => Effect.sync(() => ({ swarm, member })),
  unboundManagedMemberTargets: () => Effect.sync(() => (member.sessionID ? [] : [{ swarm, member }])),
  rebindMember: (input: SwarmV2.RebindMemberInput) =>
    Effect.sync(() => {
      order.push("bind")
      if (input.expectedBindingGeneration !== member.bindingGeneration) {
        throw new Error("unexpected stale binding in test")
      }
      member = Swarm.Member.make({
        ...member,
        sessionID: input.sessionID,
        bindingGeneration: member.bindingGeneration + 1,
        time: { ...member.time, updated: DateTime.makeUnsafe(2) },
      })
      return member
    }),
} as never)

const currentSessionMock = Layer.mock(SessionStore.Service, {
  get: (sessionID: SessionV2.ID) => Effect.succeed(sessions.get(sessionID)),
} as never)

const databaseMock = Layer.mock(Database.Service, {
  readDb: {},
} as never)

const boundaryMock = Layer.mock(SessionExecutionBoundary.Service, {
  get: (sessionID: SessionV2.ID) => Effect.succeed(boundaries.get(sessionID) as never),
  set: (sessionID: SessionV2.ID, boundary: unknown) =>
    Effect.sync(() => {
      order.push("boundary")
      boundaries.set(sessionID, boundary)
      return boundary as never
    }),
})

const instanceStoreMock = Layer.mock(InstanceStore.Service, {
  provide: (_input, effect) =>
    effect.pipe(
      Effect.provideService(InstanceRef, {
        directory: "/swarm/project",
        worktree: "/swarm/project",
        project: { id: projectID, worktree: "/swarm/project", vcs: "git", sandboxes: [], time: {} },
      } as never),
    ),
})

const fsMock = Layer.mock(FSUtil.Service, {
  isDir: () => Effect.succeed(true),
  resolve: (path: string) => Effect.succeed(path),
} as never)
const agentMock = Layer.mock(Agent.Service, {
  get: (name: string) => Effect.succeed(name === "build" ? ({ name: "build" } as never) : undefined),
} as never)
const providerMock = Layer.mock(Provider.Service, {
  getModel: () =>
    Effect.succeed({
      variants: { high: {} },
      capabilities: {
        toolcall: true,
        reasoning: true,
        attachment: true,
        temperature: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
      },
    } as never),
})
const legacySessionMock = Layer.mock(Session.Service, {
  createManagedRoot: (input: Parameters<Session.Interface["createManagedRoot"]>[0]) =>
    Effect.sync(() => {
      order.push("create")
      const existing = sessions.get(input.id)
      if (existing) {
        return {
          id: existing.id,
          slug: "managed-root",
          version: "test",
          projectID: existing.projectID,
          directory: existing.location.directory,
          title: existing.title,
          agent: existing.agent,
          model: existing.model,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 1, updated: 1 },
        } as never
      }
      sessions.set(input.id, {
        id: input.id,
        projectID,
        agent: input.agent as never,
        model: input.model as never,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(1) },
        title: input.title,
        location: { directory: "/swarm/project" } as never,
      } as SessionV2.Info)
      return {
        id: input.id,
        slug: "managed-root",
        version: "test",
        projectID,
        directory: "/swarm/project",
        title: input.title,
        agent: input.agent,
        model: input.model,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: 1, updated: 1 },
      } as never
    }),
  remove: (sessionID: SessionV2.ID) =>
    Effect.sync(() => {
      sessions.delete(sessionID)
    }),
} as never)
const worktreeMock = Layer.mock(Worktree.Service, {
  list: () => Effect.succeed([]),
  create: () => Effect.die(new Error("unused shared-read worktree create")),
} as never)
const gitMock = Layer.mock(Git.Service, { run: () => Effect.die(new Error("unused shared-read git")) } as never)

const it = testEffect(
  Layer.provide(
    SwarmMemberSession.layer,
    Layer.mergeAll(
      swarmMock,
      currentSessionMock,
      databaseMock,
      boundaryMock,
      instanceStoreMock,
      fsMock,
      agentMock,
      providerMock,
      legacySessionMock,
      worktreeMock,
      gitMock,
      // The real preflight runs against the same mocked catalog so the
      // create-time and materialize-time answers cannot drift apart.
      Layer.provide(SwarmProfilePreflight.layer, Layer.mergeAll(instanceStoreMock, fsMock, agentMock, providerMock)),
    ),
  ),
)

describe("SwarmMemberSession", () => {
  it.effect("materializes one root Session, installs its hard boundary before binding, and is retry-idempotent", () =>
    Effect.gen(function* () {
      reset()
      const service = yield* SwarmMemberSession.Service

      const first = yield* service.materialize({ swarmID, memberID })
      expect(first.status).toBe("bound")
      expect(first.member.bindingGeneration).toBe(1)
      expect(first.member.sessionID).toBe(first.sessionID)
      expect(first.sessionID).toBe(SessionV2.ID.make("ses_swarm_swm_member_session_1"))
      expect(order).toEqual(["create", "boundary", "bind"])
      expect(boundaries.get(first.sessionID)).toEqual([
        { action: "webfetch", resource: "*", effect: "ask" },
        { action: "edit", resource: "*", effect: "deny" },
        { action: "bash", resource: "*", effect: "deny" },
      ])
      expect(sessions.get(first.sessionID)?.parentID).toBeUndefined()
      expect(sessions.get(first.sessionID)?.model).toEqual(profile.model)

      order = []
      const retried = yield* service.materialize({ swarmID, memberID })
      expect(retried.status).toBe("already_bound")
      expect(retried.sessionID).toBe(first.sessionID)
      expect(order).toEqual([])
    }),
  )
})

describe("SwarmMemberSession legacy execution profiles", () => {
  // These members are hydrated from raw `desired_profile` JSON written before
  // Swarm.ModelRequirement existed, so they carry no `modelRequirements` key and
  // only the compatibility report from Swarm.normalizeLegacyExecutionProfile.
  const setLegacyMember = (
    storedProfile: Record<string, unknown>,
    capabilities: Record<string, unknown> | undefined,
  ) => {
    reset()
    member = Swarm.Member.make({
      ...member,
      desiredProfile: Swarm.normalizeLegacyExecutionProfile(storedProfile).profile,
      ...(capabilities === undefined ? {} : { capabilities: capabilities as never }),
    })
  }

  it.effect("binds a member whose recognized legacy aliases map onto supported requirements", () =>
    Effect.gen(function* () {
      const stored = {
        agent: profile.agent,
        model: profile.model,
        permissionBoundary: profile.permissionBoundary,
        requestedCapabilities: ["tools", "input:image", "output:text"],
      }
      const normalized = Swarm.normalizeLegacyExecutionProfile(stored)
      expect(normalized.unproven).toEqual([])
      expect([...normalized.profile.modelRequirements!].sort()).toEqual(["input_image", "output_text", "toolcall"])
      setLegacyMember(stored, { tags: [] })

      const service = yield* SwarmMemberSession.Service
      const result = yield* service.materialize({ swarmID, memberID })
      expect(result.status).toBe("bound")
    }),
  )

  it.effect("does not strand a member whose legacy values were only semantic routing tags", () =>
    Effect.gen(function* () {
      const stored = {
        agent: profile.agent,
        model: profile.model,
        permissionBoundary: profile.permissionBoundary,
        requestedCapabilities: ["research", "audit", "preregistration", "adversarial"],
      }
      const normalized = Swarm.normalizeLegacyExecutionProfile(stored)
      expect([...normalized.routingTags].sort()).toEqual(["adversarial", "audit", "preregistration", "research"])
      expect(normalized.unproven).toEqual([])
      setLegacyMember(stored, { tags: [], legacyRoutingTags: normalized.routingTags })

      const service = yield* SwarmMemberSession.Service
      const result = yield* service.materialize({ swarmID, memberID })
      expect(result.status).toBe("bound")
    }),
  )

  it.effect("refuses to bind a member whose legacy requirement cannot be proven", () =>
    Effect.gen(function* () {
      const stored = {
        agent: profile.agent,
        model: profile.model,
        permissionBoundary: profile.permissionBoundary,
        requestedCapabilities: ["tools", "retina-vision"],
      }
      const normalized = Swarm.normalizeLegacyExecutionProfile(stored)
      expect(normalized.unproven).toHaveLength(1)
      setLegacyMember(stored, { tags: [], legacyUnprovenRequirements: normalized.unproven })

      const service = yield* SwarmMemberSession.Service
      const result = yield* service.materialize({ swarmID, memberID }).pipe(Effect.exit)
      expect(result._tag).toBe("Failure")
      // Fail closed *before* any Session, boundary, or binding exists.
      expect(order).toEqual([])
      expect(sessions.size).toBe(0)
    }),
  )
})
