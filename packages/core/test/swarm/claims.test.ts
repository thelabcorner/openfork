import { describe as pureDescribe, expect, it as pureIt } from "bun:test"
import { DateTime, Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SwarmClaims } from "@opencode-ai/core/swarm/claims"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { WorkspaceTable } from "@opencode-ai/core/control-plane/workspace.sql"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "../lib/effect"
import { managedProfile } from "./fixture"

function expectOk(result: SwarmClaims.ParseResult): SwarmClaims.ClaimScope {
  if (!result.ok) throw new Error(`expected parse to succeed, got ${result.failure.reason}`)
  return result.scope
}

function expectFail(result: SwarmClaims.ParseResult): SwarmClaims.ParseFailure {
  if (result.ok) throw new Error(`expected parse to fail, got ${JSON.stringify(result.scope)}`)
  return result.failure
}

pureDescribe("SwarmClaims encoding", () => {
  pureIt("round-trips adversarial components containing separators, percent, unicode, and spaces", () => {
    const cases = [
      { workspace: "wrk:abc", path: "src/a:b.ts" },
      { workspace: "wrk%3Aalready", path: "src/100%/a.ts" },
      { workspace: "ワークスペース", path: "src/日本語/ファイル.ts" },
      { workspace: "wrk with spaces", path: "dir name/with space.ts" },
      { workspace: "wrk", path: "src/a%3Ab.ts" },
      { workspace: "wrk", path: "src/a:b:c:d.ts" },
    ]
    for (const entry of cases) {
      const encoded = SwarmClaims.encodeScope(
        expectOk(SwarmClaims.pathScope(entry.workspace, entry.path)),
      )
      const decoded = expectOk(SwarmClaims.parseScope(encoded))
      if (decoded.kind !== "path") throw new Error(`expected path scope for ${encoded}`)
      expect(decoded.workspace).toBe(entry.workspace)
      expect(decoded.path).toBe(entry.path)
      // Canonicalization must be idempotent.
      expect(SwarmClaims.canonicalizeScope(encoded)).toBe(encoded)
    }
  })

  pureIt("round-trips lane and resource scopes containing separators", () => {
    for (const lane of ["review:1", "50% done", "レーン"]) {
      const encoded = SwarmClaims.encodeScope(expectOk(SwarmClaims.laneScope(lane)))
      expect(expectOk(SwarmClaims.parseScope(encoded))).toEqual({ kind: "lane", lane })
    }
    for (const resource of ["db:primary", "a/b", "résumé"]) {
      const encoded = SwarmClaims.encodeScope(expectOk(SwarmClaims.resourceScope(resource)))
      expect(expectOk(SwarmClaims.parseScope(encoded))).toEqual({ kind: "resource", resource })
    }
  })

  pureIt("preserves legacy opaque scopes byte-for-byte", () => {
    for (const value of ["packages/core/src", "my arbitrary claim", "path-ish", "lane:busy"]) {
      if (SwarmClaims.isEncoded(value)) {
        expectOk(SwarmClaims.parseScope(value))
        continue
      }
      const parsed = expectOk(SwarmClaims.parseScope(value))
      expect(parsed.kind).toBe("opaque")
      expect(SwarmClaims.encodeScope(parsed)).toBe(value)
      expect(SwarmClaims.canonicalizeScope(value)).toBe(value)
    }
    expect(expectOk(SwarmClaims.parseScope("packages/core/src")).kind).toBe("opaque")
  })

  pureIt("rejects absolute and root-escaping path scopes", () => {
    expect(expectFail(SwarmClaims.pathScope("wrk", "/etc/passwd")).reason).toBe("path_not_relative")
    expect(expectFail(SwarmClaims.pathScope("wrk", "../outside.ts")).reason).toBe("path_escapes_root")
    expect(expectFail(SwarmClaims.pathScope("wrk", "a/../../b.ts")).reason).toBe("path_escapes_root")
    expect(expectFail(SwarmClaims.pathScope("", "a.ts")).reason).toBe("empty")
    expect(expectFail(SwarmClaims.pathScope("wrk", "a\\b.ts")).reason).toBe("path_escapes_root")
  })

  pureIt("treats the workspace root as directory coverage", () => {
    for (const root of [".", "./", "", "/"]) void root
    const dot = expectOk(SwarmClaims.pathScope("wrk", "."))
    expect(dot).toEqual({ kind: "path", workspace: "wrk", path: "", directory: true })
    expect(expectOk(SwarmClaims.parseScope(SwarmClaims.encodeScope(dot)))).toEqual(dot)
    const dotSlash = expectOk(SwarmClaims.pathScope("wrk", "./"))
    expect(dotSlash).toEqual(dot)
  })

  pureIt("normalizes redundant separators and dot segments", () => {
    expect(expectOk(SwarmClaims.pathScope("wrk", "./src//lib/./a.ts"))).toEqual({
      kind: "path",
      workspace: "wrk",
      path: "src/lib/a.ts",
      directory: false,
    })
  })

  pureIt("reports malformed typed encodings instead of throwing", () => {
    expect(expectFail(SwarmClaims.parseScope("path:no-separator")).reason).toBe("missing_separator")
    expect(expectFail(SwarmClaims.parseScope("path:%E0%A4%A:src/a.ts")).reason).toBe("malformed_encoding")
    expect(expectFail(SwarmClaims.parseScope("path::src/a.ts")).reason).toBe("empty")
    expect(expectFail(SwarmClaims.parseScope("path:wrk:%2Fabsolute")).reason).toBe("path_not_relative")
    expect(expectFail(SwarmClaims.parseScope("   ")).reason).toBe("empty")
  })
})

pureDescribe("SwarmClaims overlap", () => {
  const path = (workspace: string, value: string, directory?: boolean) =>
    expectOk(SwarmClaims.pathScope(workspace, value, directory))

  pureIt("conflicts identical paths only within the same workspace", () => {
    expect(SwarmClaims.scopesOverlap(path("wrk", "src/a.ts"), path("wrk", "src/a.ts"))).toBe(true)
    expect(SwarmClaims.scopesOverlap(path("wrk", "src/a.ts"), path("other", "src/a.ts"))).toBe(false)
  })

  pureIt("does not treat sibling files with a shared prefix as overlapping", () => {
    expect(SwarmClaims.scopesOverlap(path("wrk", "src/a.ts"), path("wrk", "src/ab.ts"))).toBe(false)
    expect(SwarmClaims.scopesOverlap(path("wrk", "src/a"), path("wrk", "src/ab.ts"))).toBe(false)
  })

  pureIt("honors explicit directory coverage in both directions", () => {
    expect(SwarmClaims.scopesOverlap(path("wrk", "src", true), path("wrk", "src/lib/a.ts"))).toBe(true)
    expect(SwarmClaims.scopesOverlap(path("wrk", "src/lib/a.ts"), path("wrk", "src", true))).toBe(true)
    expect(SwarmClaims.scopesOverlap(path("wrk", "src"), path("wrk", "src/lib/a.ts"))).toBe(false)
  })

  pureIt("treats a root claim as whole-workspace coverage", () => {
    const root = path("wrk", ".")
    expect(SwarmClaims.scopesOverlap(root, path("wrk", "packages/core/src/swarm/index.ts"))).toBe(true)
    expect(SwarmClaims.scopesOverlap(path("wrk", "packages/core"), root)).toBe(true)
    expect(SwarmClaims.scopesOverlap(root, path("other", "packages/core"))).toBe(false)
  })

  pureIt("separates lanes, resources, and kinds", () => {
    const laneA = expectOk(SwarmClaims.laneScope("review"))
    const laneB = expectOk(SwarmClaims.laneScope("build"))
    expect(SwarmClaims.scopesOverlap(laneA, expectOk(SwarmClaims.laneScope("review")))).toBe(true)
    expect(SwarmClaims.scopesOverlap(laneA, laneB)).toBe(false)
    expect(SwarmClaims.scopesOverlap(laneA, expectOk(SwarmClaims.resourceScope("review")))).toBe(false)
    expect(SwarmClaims.scopesOverlap(path("wrk", "a.ts"), expectOk(SwarmClaims.laneScope("a.ts")))).toBe(false)
  })

  pureIt("never lets an opaque scope conflict", () => {
    const opaque = expectOk(SwarmClaims.parseScope("src/a.ts"))
    expect(SwarmClaims.scopesOverlap(opaque, opaque)).toBe(false)
    expect(SwarmClaims.scopesOverlap(opaque, path("wrk", "src/a.ts"))).toBe(false)
    expect(SwarmClaims.scopesOverlap(path("wrk", "src/a.ts"), opaque)).toBe(false)
  })

  pureIt("compares paths case-sensitively and documents that as a host obligation", () => {
    expect(SwarmClaims.scopesOverlap(path("wrk", "src/A.ts"), path("wrk", "src/a.ts"))).toBe(false)
    expect(SwarmClaims.CASE_SENSITIVITY.coreComparison).toBe("case-sensitive")
    expect(SwarmClaims.CASE_SENSITIVITY.requirement).toContain("canonicalize")
  })
})

pureDescribe("SwarmClaims liveness", () => {
  pureIt("treats released and expired claims as non-live", () => {
    expect(SwarmClaims.isLiveClaim({}, 100)).toBe(true)
    expect(SwarmClaims.isLiveClaim({ expiresAt: 200 }, 100)).toBe(true)
    expect(SwarmClaims.isLiveClaim({ expiresAt: 100 }, 100)).toBe(false)
    expect(SwarmClaims.isLiveClaim({ expiresAt: 200, releasedAt: 50 }, 100)).toBe(false)
    expect(SwarmClaims.isLiveClaim({ expiresAt: null, releasedAt: null }, 100)).toBe(true)
    expect(SwarmClaims.isLiveClaim({ expiresAt: undefined, releasedAt: undefined }, 100)).toBe(true)
  })

  pureIt("filters conflicts by liveness, ownership, and stopped owners", () => {
    const requested = expectOk(SwarmClaims.pathScope("wrk", "src/a.ts"))
    const candidates = [
      { scope: "path:wrk:src/a.ts", memberID: "m1" },
      { scope: "path:wrk:src/a.ts", memberID: "m2" },
      { scope: "path:wrk:src/a.ts", memberID: "m3", releasedAt: 10 },
      { scope: "path:wrk:src/a.ts", memberID: "m4", expiresAt: 50 },
      { scope: "path:wrk:src/a.ts", memberID: "m5", lifecycle: "stopped" },
      { scope: "path:wrk:src/a.ts", memberID: "m6", lifecycle: "stopping" },
      { scope: "legacy-scope", memberID: "m7" },
    ]
    const conflicts = SwarmClaims.findConflicts(requested, candidates, { now: 100, ownerMemberID: "m2" })
    expect(conflicts.map((conflict) => conflict.memberID).sort()).toEqual(["m1", "m6"])
  })

  pureIt("never blocks on an opaque request", () => {
    const opaque = expectOk(SwarmClaims.parseScope("anything"))
    expect(
      SwarmClaims.findConflicts(opaque, [{ scope: "path:wrk:src/a.ts", memberID: "m1" }], { now: 1 }),
    ).toEqual([])
  })
})

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SwarmV2.node]),
  ),
).effect

const projectID = ProjectV2.ID.make("swarm-claims-project")
const workspaceID = WorkspaceV2.ID.make("wrk_swarm_claims")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const service = yield* SwarmV2.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: projectID, worktree: AbsolutePath.make("/swarm/claims"), sandboxes: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkspaceTable)
    .values({ id: workspaceID, type: "local", name: "claims", project_id: projectID, time_used: 1 })
    .run()
    .pipe(Effect.orDie)
  const swarm = yield* service.create({
    projectID,
    workspaceID,
    directory: "/swarm/claims",
    name: "claims swarm",
    now: 10,
  })
  const members = []
  for (const name of ["a", "b", "c"]) {
    members.push(
      yield* service.addMember({
        swarmID: swarm.id,
        name,
        kind: "managed_worker",
        role: "worker",
        desiredProfile: managedProfile,
        workspacePolicy: { mode: "shared-write" },
        now: 20,
      }),
    )
  }
  return { service, swarm, members }
})

it("typed path claims exclude other members but admit expired and released holders", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b] = members

    const first = yield* service.acquireClaim({
      swarmID: swarm.id,
      memberID: a.id,
      scope: "path:wrk:src/a.ts",
      now: 100,
    })
    expect(first.claim.scope).toBe("path:wrk:src/a.ts")

    // The holder re-acquiring its own live scope still fails as claim_active, so
    // typed overlap never masks the pre-existing single-generation rule.
    const selfReacquire = yield* Effect.flip(
      service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope: "path:wrk:src/a.ts", now: 110 }),
    )
    expect(selfReacquire._tag).toBe("Swarm.ConflictError")
    expect((selfReacquire as SwarmSchema.ConflictError).code).toBe("swarm.claim_active")

    const denied = yield* Effect.flip(
      service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "path:wrk:src/a.ts", now: 120 }),
    )
    expect(denied._tag).toBe("Swarm.ConflictError")
    expect((denied as SwarmSchema.ConflictError).code).toBe("swarm.claim_conflict")

    // Expired holders do not block.
    yield* service.acquireClaim({
      swarmID: swarm.id,
      memberID: a.id,
      scope: "path:wrk:src/b.ts",
      expiresAt: 130,
      now: 100,
    })
    yield* service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "path:wrk:src/b.ts", now: 200 })

    // Released holders do not block.
    yield* service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope: "path:wrk:src/c.ts", now: 100 })
    yield* service.releaseClaim({
      token: { swarmID: swarm.id, memberID: a.id, scope: "path:wrk:src/c.ts", generation: 1 },
      now: 110,
    })
    yield* service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "path:wrk:src/c.ts", now: 120 })
  }))

it("keeps legacy opaque scopes advisory and back-compatible", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b] = members

    // Opaque scopes from two different members never conflict.
    yield* service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope: "src/a.ts", now: 100 })
    yield* service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "src/a.ts", now: 101 })

    // The durable value is preserved verbatim, not rewritten into typed form.
    const claims = yield* service.claims(swarm.id)
    expect(claims.some((claim) => claim.scope === "src/a.ts")).toBe(true)

    // A conflict probe for an opaque scope reports nothing.
    expect(
      yield* service.claimConflictsFor({ swarmID: swarm.id, scope: "src/a.ts", ownerMemberID: b.id, now: 110 }),
    ).toEqual([])

    // ...while a typed probe against a typed holder reports the holder.
    yield* service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope: "path:wrk:src/d.ts", now: 100 })
    const conflicts = yield* service.claimConflictsFor({
      swarmID: swarm.id,
      scope: "path:wrk:src/d.ts",
      ownerMemberID: b.id,
      now: 110,
    })
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.claim.memberID).toBe(a.id)
    expect(conflicts[0]!.memberLifecycle).toBeDefined()
  }))

it("degrades an unparseable typed prefix to the advisory opaque form", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b] = members

    // `scope` is an agent-facing free-text column that predates typed claims, so a
    // string that merely looks typed must still be storable. Hard-rejecting it
    // would break a stable advisory surface for an additive coordination feature.
    for (const raw of ["path:no-separator", "path:src/a.ts", "path-ish", "path:"]) {
      const acquired = yield* service.acquireClaim({
        swarmID: swarm.id,
        memberID: a.id,
        scope: raw,
        now: 100,
      })
      // Stored verbatim, never rewritten into typed form.
      expect(acquired.claim.scope).toBe(raw)
      // Degradation is fail-safe: it protects nothing, and never blocks a peer.
      expect(
        yield* service.claimConflictsFor({ swarmID: swarm.id, scope: raw, ownerMemberID: b.id, now: 110 }),
      ).toEqual([])
      const peer = yield* service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: raw, now: 110 })
      expect(peer.claim.scope).toBe(raw)
    }

    // A well-formed typed scope is still normalized on the way in.
    const acquired = yield* service.acquireClaim({
      swarmID: swarm.id,
      memberID: a.id,
      scope: "path:wrk:./src//lib/../lib/a.ts/",
      now: 200,
    })
    expect(acquired.claim.scope).toBe("path:wrk:src/lib/a.ts/")

    // ...and it still conflicts for real, proving degradation did not weaken the
    // typed path: only the malformed strings above degrade.
    const denied = yield* Effect.flip(
      service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "path:wrk:src/lib/a.ts", now: 210 }),
    )
    if (denied._tag !== "Swarm.ConflictError") throw new Error(`expected ConflictError, got ${denied._tag}`)
    expect(denied.code).toBe("swarm.claim_conflict")
  }))

it("frees a typed scope only once the holder is stopped, never while merely stopping", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b] = members
    const scope = "path:wrk:src/rebind.ts"

    yield* service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope, now: 100 })

    // Retirement is asynchronous, so a `stopping` member still owns its claim.
    // Releasing it early would let a peer start work the member is still finishing.
    yield* service.setMemberLifecycle({
      swarmID: swarm.id,
      memberID: a.id,
      expectedLifecycle: "active",
      lifecycle: "stopping",
      now: 110,
    })
    const whileStopping = yield* Effect.flip(
      service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope, now: 120 }),
    )
    expect(whileStopping._tag).toBe("Swarm.ConflictError")

    // Once the member is fully stopped its claim must NOT keep freezing the scope
    // for the rest of the Swarm. This is the deadlock guard: a dead owner that
    // never released would otherwise strand the path forever.
    yield* service.setMemberLifecycle({
      swarmID: swarm.id,
      memberID: a.id,
      expectedLifecycle: "stopping",
      lifecycle: "stopped",
      now: 130,
    })
    const afterStop = yield* service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope, now: 140 })
    expect(afterStop.claim.memberID).toBe(b.id)
  }))

it("frees a typed scope on expiry without any explicit release", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b] = members
    const scope = "path:wrk:src/ttl.ts"

    yield* service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope, expiresAt: 200, now: 100 })

    // Still live just before expiry.
    const held = yield* Effect.flip(
      service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope, now: 199 }),
    )
    expect(held._tag).toBe("Swarm.ConflictError")

    // Expired without release: the durable row survives for audit but stops owning.
    const reclaimed = yield* service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope, now: 200 })
    expect(reclaimed.claim.memberID).toBe(b.id)
    expect(reclaimed.claim.generation).toBe(1)
  }))

it("keeps the mutation-boundary probe advisory, read-only, and free of self-conflicts", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b] = members
    const scope = "path:wrk:src/probe.ts"

    // Probing an uncontested scope reserves nothing and reports nothing.
    expect(
      yield* service.claimConflictsFor({ swarmID: swarm.id, scope, ownerMemberID: b.id, now: 100 }),
    ).toEqual([])

    yield* service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope, now: 100 })
    const before = yield* service.claims(swarm.id)

    // A peer sees the holder...
    const peer = yield* service.claimConflictsFor({ swarmID: swarm.id, scope, ownerMemberID: b.id, now: 110 })
    expect(peer.map((conflict) => conflict.claim.memberID)).toEqual([a.id])

    // ...the holder does not see itself, so a member editing its own claimed path
    // is never warned against its own work.
    expect(yield* service.claimConflictsFor({ swarmID: swarm.id, scope, ownerMemberID: a.id, now: 110 })).toEqual([])

    // Probing repeatedly mutates nothing.
    yield* service.claimConflictsFor({ swarmID: swarm.id, scope, ownerMemberID: b.id, now: 120 })
    expect((yield* service.claims(swarm.id)).length).toBe(before.length)

    // An opaque probe never blocks, even against a live typed holder.
    expect(
      yield* service.claimConflictsFor({ swarmID: swarm.id, scope: "src/probe.ts", ownerMemberID: b.id, now: 130 }),
    ).toEqual([])

    // A directory probe reports the holder of a file beneath it, which is what a
    // mutation boundary needs when it is about to write a whole subtree.
    const subtree = yield* service.claimConflictsFor({
      swarmID: swarm.id,
      scope: "path:wrk:src/",
      ownerMemberID: b.id,
      now: 140,
    })
    expect(subtree.map((conflict) => conflict.claim.memberID)).toEqual([a.id])
  }))

it("serializes concurrent overlapping typed acquisitions so exactly one member wins", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b, c] = members

    // Two members racing for the SAME typed path: exactly one must win.
    const samePath = yield* Effect.all(
      [
        Effect.exit(service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope: "path:wrk:src/race.ts", now: 100 })),
        Effect.exit(service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "path:wrk:src/race.ts", now: 100 })),
      ],
      { concurrency: "unbounded" },
    )
    expect(samePath.filter((exit) => exit._tag === "Success")).toHaveLength(1)
    const samePathLosers = samePath.filter((exit) => exit._tag === "Failure")
    expect(samePathLosers).toHaveLength(1)
    expect(JSON.stringify(samePathLosers[0])).toContain("swarm.claim_conflict")

    // Racing across a DIRECTORY PREFIX boundary, not just identical paths.
    const prefix = yield* Effect.all(
      [
        Effect.exit(service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "path:wrk:src/lib/", now: 200 })),
        Effect.exit(
          service.acquireClaim({ swarmID: swarm.id, memberID: c.id, scope: "path:wrk:src/lib/deep/x.ts", now: 200 }),
        ),
      ],
      { concurrency: "unbounded" },
    )
    expect(prefix.filter((exit) => exit._tag === "Success")).toHaveLength(1)
    expect(prefix.filter((exit) => exit._tag === "Failure")).toHaveLength(1)

    // Negative invariant: no two members ever hold overlapping live typed claims.
    const held = (yield* service.claims(swarm.id)).filter(
      (claim) =>
        claim.releasedAt === undefined &&
        (claim.expiresAt === undefined || DateTime.toDate(claim.expiresAt).getTime() > 300),
    )
    for (const left of held) {
      for (const right of held) {
        if (left.memberID === right.memberID) continue
        expect(
          SwarmClaims.scopesOverlap(
            expectOk(SwarmClaims.parseScope(left.scope)),
            expectOk(SwarmClaims.parseScope(right.scope)),
          ),
        ).toBe(false)
      }
    }
  }))

it("never serializes concurrent legacy opaque acquisitions", () =>
  Effect.gen(function* () {
    const { service, swarm, members } = yield* setup
    const [a, b, c] = members

    // Opaque scopes stay advisory: three members may hold the same string.
    const results = yield* Effect.all(
      [
        Effect.exit(service.acquireClaim({ swarmID: swarm.id, memberID: a.id, scope: "src/shared.ts", now: 100 })),
        Effect.exit(service.acquireClaim({ swarmID: swarm.id, memberID: b.id, scope: "src/shared.ts", now: 100 })),
        Effect.exit(service.acquireClaim({ swarmID: swarm.id, memberID: c.id, scope: "src/shared.ts", now: 100 })),
      ],
      { concurrency: "unbounded" },
    )
    expect(results.every((exit) => exit._tag === "Success")).toBe(true)
    expect(yield* service.claims(swarm.id)).toHaveLength(3)
  }))
