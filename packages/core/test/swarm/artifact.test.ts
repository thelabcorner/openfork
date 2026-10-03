import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SwarmArtifact } from "../../src/swarm/artifact"
import { Swarm } from "@opencode-ai/schema/swarm"

const swarmID = Swarm.ID.make("swr_artifact_proof")
const producer = Swarm.MemberID.make("swm_artifact_producer")

const sharedDirectory: SwarmArtifact.WorkspaceProvenance = {
  kind: "shared_directory",
  directory: "/repo",
}

const producerWorktree: SwarmArtifact.WorkspaceProvenance = {
  kind: "worktree",
  directory: "/repo-worktrees/opencode-swm_artifact_producer",
  branch: "opencode/opencode-swm_artifact_producer",
}

const consumerWorktree: SwarmArtifact.WorkspaceProvenance = {
  kind: "worktree",
  directory: "/repo-worktrees/opencode-swm_artifact_consumer",
  branch: "opencode/opencode-swm_artifact_consumer",
}

const context = (workspace: SwarmArtifact.WorkspaceProvenance, createdAtMillis = 1_000) => ({
  swarmID,
  producerMemberID: producer,
  workspace,
  createdAtMillis,
})

/** Runs the validation and returns the typed rejection reason instead of throwing. */
function rejection(input: SwarmArtifact.ArtifactInput, workspace = sharedDirectory) {
  return Effect.runSync(Effect.flip(SwarmArtifact.validateArtifact(input, context(workspace))))
}

function artifact(input: SwarmArtifact.ArtifactInput, workspace = sharedDirectory) {
  return Effect.runSync(SwarmArtifact.validateArtifact(input, context(workspace)))
}

function identityOf(value: string) {
  return SwarmArtifact.contentIdentityOf(new TextEncoder().encode(value))
}

describe("SwarmArtifact.validateArtifact", () => {
  test("derives durability from the declared backing instead of trusting the publisher", () => {
    const path = artifact({ path: "reports/audit.md", createdAtMillis: 1 })
    expect(path.backing).toBe("workspace_path")
    expect(path.durability).toBe("producer_workspace_only")
    expect(SwarmArtifact.isDurable(path)).toBe(false)

    const committed = artifact({
      path: "reports/audit.md",
      backing: "git_object",
      git: { kind: "commit", object: "a".repeat(40), path: "reports/audit.md" },
      createdAtMillis: 1,
    })
    expect(committed.durability).toBe("repository_durable")
    expect(SwarmArtifact.isDurable(committed)).toBe(true)
  })

  test("rejects a git_object artifact without a repository reference", () => {
    expect(rejection({ path: "out.md", backing: "git_object", createdAtMillis: 1 }).reason).toContain(
      "commit/blob/patch reference",
    )
  })

  test("rejects a git object that is not a full object id", () => {
    expect(
      rejection({
        path: "out.md",
        backing: "git_object",
        git: { kind: "commit", object: "HEAD" },
        createdAtMillis: 1,
      }).reason,
    ).toContain("40 character object id")
  })

  test("refuses to let a patch reference claim durability without a verifiable object id", () => {
    // A patch anchored to nothing content-addressable has no verifiable content
    // identity, so it must not be minted as `repository_durable`.
    expect(
      rejection({
        path: "out.md",
        backing: "git_object",
        git: { kind: "patch", object: "reviewer-notes.patch" },
        createdAtMillis: 1,
      }).reason,
    ).toContain("40 character object id")

    const anchored = artifact({
      path: "out.md",
      backing: "git_object",
      git: { kind: "patch", object: "c".repeat(40), path: "out.md" },
      createdAtMillis: 1,
    })
    expect(anchored.durability).toBe("repository_durable")
    expect(SwarmArtifact.isDurable(anchored)).toBe(true)
  })

  test("requires content identity before claiming a durable content store", () => {
    expect(rejection({ path: "out.bin", backing: "content_store", createdAtMillis: 1 }).reason).toContain(
      "content digest and byte size",
    )

    const bytes = new TextEncoder().encode("artifact bytes")
    const identity = SwarmArtifact.contentIdentityOf(bytes)
    const stored = artifact({
      path: "out.bin",
      backing: "content_store",
      digest: identity.digest,
      sizeBytes: identity.sizeBytes,
      createdAtMillis: 1,
    })
    expect(stored.durability).toBe("content_store_durable")
    expect(SwarmArtifact.verifyContent(stored, bytes)).toBe(true)
    expect(SwarmArtifact.verifyContent(stored, new TextEncoder().encode("tampered"))).toBe(false)
  })

  test("rejects paths that are absolute or escape the producing workspace", () => {
    for (const path of ["/etc/passwd", "C:/Windows/system32", "../outside.md", "reports/../../outside.md", ""]) {
      expect(rejection({ path, createdAtMillis: 1 })).toBeInstanceOf(SwarmArtifact.InvalidArtifactError)
    }
  })

  test("normalizes windows separators without changing the logical path meaning", () => {
    expect(String(artifact({ path: "reports\\nested\\audit.md", createdAtMillis: 1 }).path)).toBe(
      "reports/nested/audit.md",
    )
  })

  test("infers media types from the artifact path", () => {
    expect(SwarmArtifact.inferMediaType("reports/audit.md")).toBe("text/markdown")
    expect(SwarmArtifact.inferMediaType("data/report.json")).toBe("application/json")
    expect(SwarmArtifact.inferMediaType("LICENSE")).toBeUndefined()
  })
})

describe("SwarmArtifact.artifactsFromPublishedPaths", () => {
  test("keeps legacy deliverable paths honest instead of implying durable bytes", () => {
    const artifacts = Effect.runSync(
      SwarmArtifact.artifactsFromPublishedPaths(
        ["reports/audit.md", "reports/audit.md", "notes.md"],
        context(producerWorktree),
      ),
    )
    expect(artifacts.map((item) => String(item.path))).toEqual(["reports/audit.md", "notes.md"])
    expect(artifacts.every((item) => item.durability === "producer_workspace_only")).toBe(true)
    expect(artifacts.every((item) => item.digest === undefined)).toBe(true)
    expect(artifacts.every((item) => item.workspace.directory === producerWorktree.directory)).toBe(true)
  })

  test("bounds how many artifacts one deliverable may publish", () => {
    const many = Array.from({ length: SwarmArtifact.MAX_ARTIFACTS_PER_DELIVERABLE + 1 }, (_, index) => `f${index}.md`)
    const result = Effect.runSync(
      Effect.flip(SwarmArtifact.artifactsFromPublishedPaths(many, context(sharedDirectory))),
    )
    expect(result.reason).toContain(`at most ${SwarmArtifact.MAX_ARTIFACTS_PER_DELIVERABLE} artifacts`)
  })
})

describe("SwarmArtifact.planConsume", () => {
  test("reads a shared-directory path in place without materializing", () => {
    const published = artifact({ path: "reports/audit.md", createdAtMillis: 1 }, sharedDirectory)
    expect(SwarmArtifact.planConsume(published, sharedDirectory)).toEqual({
      kind: "read_in_place",
      path: published.path,
      requiresMaterialization: false,
    })
  })

  test("fails closed for worktree-to-worktree consumption instead of assuming a shared path", () => {
    const published = artifact({ path: "reports/audit.md", createdAtMillis: 1 }, producerWorktree)
    const plan = SwarmArtifact.planConsume(published, consumerWorktree)
    expect(plan.kind).toBe("unavailable")
    expect(plan.requiresMaterialization).toBe(true)
    if (plan.kind === "unavailable") {
      expect(plan.reason).toContain(producerWorktree.directory)
      expect(plan.reason).toContain(consumerWorktree.directory)
      expect(plan.reason).toContain("git_object or content_store")
    }
  })

  test("consumes a committed artifact from another worktree through the shared object store", () => {
    const published = artifact(
      {
        path: "reports/audit.md",
        backing: "git_object",
        git: { kind: "commit", object: "b".repeat(40), path: "reports/audit.md" },
        createdAtMillis: 1,
      },
      producerWorktree,
    )
    expect(SwarmArtifact.planConsume(published, consumerWorktree)).toEqual({
      kind: "restore_from_git",
      git: published.git!,
      requiresMaterialization: true,
    })
  })

  test("consumes a content-store artifact by digest rather than by path", () => {
    const identity = SwarmArtifact.contentIdentityOf(new TextEncoder().encode("bytes"))
    const published = artifact(
      {
        path: "out.bin",
        backing: "content_store",
        digest: identity.digest,
        sizeBytes: identity.sizeBytes,
        createdAtMillis: 1,
      },
      producerWorktree,
    )
    expect(SwarmArtifact.planConsume(published, consumerWorktree)).toEqual({
      kind: "fetch_from_content_store",
      digest: identity.digest,
      sizeBytes: identity.sizeBytes,
      requiresMaterialization: true,
    })
  })

  test("never degrades a promised content-addressed backing into a path read", () => {
    // Same-workspace consumption would otherwise return read_in_place and imply
    // the bytes are reachable there, which a stripped identity cannot support.
    const stripped = {
      ...artifact({ path: "out.bin", backing: "content_store", ...identityOf("bytes"), createdAtMillis: 1 }),
      digest: undefined,
      sizeBytes: undefined,
    } as unknown as SwarmArtifact.Artifact
    const plan = SwarmArtifact.planConsume(stripped, sharedDirectory)
    expect(plan.kind).toBe("unavailable")
    expect(plan.requiresMaterialization).toBe(true)
    if (plan.kind === "unavailable") expect(plan.reason).toContain("without content identity")

    const orphan = {
      ...artifact({
        path: "out.md",
        backing: "git_object",
        git: { kind: "commit", object: "d".repeat(40) },
        createdAtMillis: 1,
      }),
      git: undefined,
    } as unknown as SwarmArtifact.Artifact
    const orphanPlan = SwarmArtifact.planConsume(orphan, sharedDirectory)
    expect(orphanPlan.kind).toBe("unavailable")
    if (orphanPlan.kind === "unavailable") expect(orphanPlan.reason).toContain("without a repository reference")
  })
})

describe("SwarmArtifact.assertDurableClaim", () => {
  test("accepts a hydrated artifact whose durability matches its backing", () => {
    const stored = artifact({ path: "out.bin", backing: "content_store", ...identityOf("bytes"), createdAtMillis: 1 })
    expect(Effect.runSync(SwarmArtifact.assertDurableClaim(stored))).toEqual(stored)
  })

  test("rejects a stored row that claims durable bytes for a workspace path", () => {
    const stored = artifact({ path: "reports/audit.md", createdAtMillis: 1 })
    const forged = { ...stored, durability: "content_store_durable" } as SwarmArtifact.Artifact
    const rejection = Effect.runSync(Effect.flip(SwarmArtifact.assertDurableClaim(forged)))
    expect(rejection.reason).toContain("does not match backing")
  })

  test("rejects a stored content_store row with no content identity", () => {
    const stored = artifact({ path: "out.bin", backing: "content_store", ...identityOf("bytes"), createdAtMillis: 1 })
    const stripped = { ...stored, digest: undefined, sizeBytes: undefined } as unknown as SwarmArtifact.Artifact
    const rejection = Effect.runSync(Effect.flip(SwarmArtifact.assertDurableClaim(stripped)))
    expect(rejection.reason).toContain("missing its content identity")
  })
})

describe("SwarmArtifact.describeArtifact", () => {
  test("never reports unverified content as durable", () => {
    const described = SwarmArtifact.describeArtifact(
      artifact({ path: "reports/audit.md", createdAtMillis: 1 }, producerWorktree),
    )
    expect(described).toContain("producer_workspace_only")
    expect(described).toContain("unverified content")
    expect(described).not.toContain("durable")
  })
})
