export * as SwarmArtifact from "./artifact"

import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { Swarm } from "@opencode-ai/schema/swarm"
import { optional } from "@opencode-ai/schema/schema"

/**
 * Swarm artifact contract.
 *
 * A Swarm artifact is a *provenance-bearing reference* to bytes produced by a
 * member. This module deliberately separates three different claims that the
 * previous `Deliverable.files: string[]` contract silently conflated:
 *
 * 1. where the bytes were produced (producer member, task run, workspace);
 * 2. what the bytes are (path, digest, size, media type);
 * 3. whether the bytes are actually reachable by another member.
 *
 * Only `content_store` and `git_object` artifacts may claim durable bytes.
 * A `workspace_path` artifact is honest about being readable only from the
 * workspace that produced it, which is exactly the worktree-to-worktree case
 * a path string alone gets wrong.
 *
 * Ownership: this file owns artifact *semantics* (validation, durability
 * classification, consumption planning). Durable persistence (table, migration,
 * event) and the byte store itself are intentionally NOT decided here; see the
 * coordinator proposal in the Lane 7 report.
 */

export const MAX_ARTIFACT_PATH_LENGTH = 512
export const MAX_ARTIFACTS_PER_DELIVERABLE = 64

const DIGEST = /^sha256:[0-9a-f]{64}$/
const GIT_OBJECT = /^[0-9a-f]{40}$/

export class InvalidArtifactError extends Schema.TaggedErrorClass<InvalidArtifactError>()(
  "SwarmArtifact.InvalidArtifactError",
  { reason: Schema.String },
) {
  override get message() {
    return `Swarm artifact rejected: ${this.reason}`
  }
}

/** Content digest of the artifact bytes. Self-describing so the algorithm is never implied. */
export const ContentDigest = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(DIGEST)).pipe(
  Schema.brand("SwarmArtifact.ContentDigest"),
)
export type ContentDigest = typeof ContentDigest.Type

/** Workspace-relative, normalized POSIX path. Never absolute, never escaping the workspace root. */
export const LogicalPath = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ARTIFACT_PATH_LENGTH),
).pipe(Schema.brand("SwarmArtifact.LogicalPath"))
export type LogicalPath = typeof LogicalPath.Type

export const WorkspaceKind = Schema.Literals(["shared_directory", "worktree"]).annotate({
  identifier: "SwarmArtifact.WorkspaceKind",
})
export type WorkspaceKind = typeof WorkspaceKind.Type

/**
 * Workspace the producing Session actually ran in. `directory` is provenance
 * for reasoning about reachability; it is never a durable artifact location.
 */
export interface WorkspaceProvenance extends Schema.Schema.Type<typeof WorkspaceProvenance> {}
export const WorkspaceProvenance = Schema.Struct({
  kind: WorkspaceKind,
  directory: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  /** Managed member branch for worktree workspaces. Absent for shared directories. */
  branch: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
}).annotate({ identifier: "SwarmArtifact.WorkspaceProvenance" })

/** Where the artifact bytes live. This is the only authority for the durability claim. */
export const ArtifactBacking = Schema.Literals(["workspace_path", "git_object", "content_store"]).annotate({
  identifier: "SwarmArtifact.ArtifactBacking",
})
export type ArtifactBacking = typeof ArtifactBacking.Type

/** Derived, materialized durability class. Callers must not construct it independently of the backing. */
export const ArtifactDurability = Schema.Literals([
  "producer_workspace_only",
  "repository_durable",
  "content_store_durable",
]).annotate({ identifier: "SwarmArtifact.ArtifactDurability" })
export type ArtifactDurability = typeof ArtifactDurability.Type

export const GitObjectKind = Schema.Literals(["commit", "blob", "patch"]).annotate({
  identifier: "SwarmArtifact.GitObjectKind",
})
export type GitObjectKind = typeof GitObjectKind.Type

/**
 * Repository object reference. Worktrees of one repository share a single
 * object store, so a committed object is genuinely consumable from another
 * member worktree; a plain path is not.
 */
export interface GitRef extends Schema.Schema.Type<typeof GitRef> {}
export const GitRef = Schema.Struct({
  kind: GitObjectKind,
  /**
   * Content-addressable object id, for every kind. For `patch` this is the
   * commit the patch is anchored to, not an opaque patch label, so a
   * `git_object` backing never claims `repository_durable` for something no
   * object store can resolve and no consumer can verify.
   */
  object: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  /** Path inside the tree when the object is a commit or a patch target. */
  path: optional(LogicalPath),
}).annotate({ identifier: "SwarmArtifact.GitRef" })

/** Producer-facing Git reference. Paths are normalized before they become a durable record. */
export interface GitRefInput {
  readonly kind: GitObjectKind
  readonly object: string
  readonly path?: string
}

export interface Artifact extends Schema.Schema.Type<typeof Artifact> {}
export const Artifact = Schema.Struct({
  swarmID: Swarm.ID,
  producerMemberID: Swarm.MemberID,
  taskRunID: optional(Swarm.TaskRunID),
  deliverableID: optional(Swarm.DeliverableID),
  path: LogicalPath,
  backing: ArtifactBacking,
  durability: ArtifactDurability,
  mediaType: optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  sizeBytes: optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  digest: optional(ContentDigest),
  workspace: WorkspaceProvenance,
  git: optional(GitRef),
  createdAtMillis: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({ identifier: "SwarmArtifact.Artifact" })

export const DURABILITY_BY_BACKING = {
  workspace_path: "producer_workspace_only",
  git_object: "repository_durable",
  content_store: "content_store_durable",
} as const satisfies Record<ArtifactBacking, ArtifactDurability>

export function durabilityOf(backing: ArtifactBacking): ArtifactDurability {
  return DURABILITY_BY_BACKING[backing]
}

/** True only when the bytes survive the producing member's workspace and are addressable by another member. */
export function isDurable(artifact: Pick<Artifact, "durability">) {
  return artifact.durability !== "producer_workspace_only"
}

export interface ArtifactContentIdentity {
  readonly digest: ContentDigest
  readonly sizeBytes: number
}

export function digestOf(bytes: Uint8Array): ContentDigest {
  return ContentDigest.make("sha256:" + createHash("sha256").update(bytes).digest("hex"))
}

/** Host-side integrity check used before publishing content claims and before consuming them. */
export function contentIdentityOf(bytes: Uint8Array): ArtifactContentIdentity {
  return { digest: digestOf(bytes), sizeBytes: bytes.byteLength }
}

export function verifyContent(
  identity: { readonly digest?: ContentDigest; readonly sizeBytes?: number },
  bytes: Uint8Array,
) {
  if (identity.digest === undefined || identity.sizeBytes === undefined) return false
  return digestOf(bytes) === identity.digest && bytes.byteLength === identity.sizeBytes
}

const MEDIA_TYPES: Record<string, string> = {
  md: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  jsonl: "application/x-ndjson",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  ts: "text/x-typescript",
  tsx: "text/x-typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  rs: "text/x-rust",
  go: "text/x-go",
  sh: "text/x-shellscript",
  patch: "text/x-diff",
  diff: "text/x-diff",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  zip: "application/zip",
  gz: "application/gzip",
}

export function inferMediaType(path: string) {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  return extension === path ? undefined : MEDIA_TYPES[extension]
}

function invalid(reason: string) {
  return new InvalidArtifactError({ reason })
}

function normalizedPath(input: string): { readonly path: LogicalPath } | { readonly reason: string } {
  const value = input.trim().replaceAll("\\", "/")
  if (!value) return { reason: "Artifact path is required." }
  if (value.length > MAX_ARTIFACT_PATH_LENGTH)
    return { reason: `Artifact path exceeds ${MAX_ARTIFACT_PATH_LENGTH} characters.` }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(value)) return { reason: "Artifact path contains control characters." }
  if (value.startsWith("/") || /^[A-Za-z]:\//.test(value) || value.startsWith("//"))
    return { reason: `Artifact path must be workspace-relative: ${input}` }
  const segments = value.split("/")
  for (const segment of segments) {
    if (segment === "") return { reason: `Artifact path has an empty segment: ${input}` }
    if (segment === "." || segment === "..") return { reason: `Artifact path must not traverse: ${input}` }
  }
  return { path: LogicalPath.make(segments.join("/")) }
}

/**
 * Normalizes a producer-supplied path into a workspace-relative logical path.
 * Absolute paths and traversal are rejected because an artifact path is a
 * workspace-relative handle, not a filesystem location.
 */
export function normalizeLogicalPath(input: string) {
  return Effect.gen(function* () {
    const result = normalizedPath(input)
    if ("reason" in result) return yield* invalid(result.reason)
    return result.path
  })
}

export interface ArtifactInput {
  readonly path: string
  readonly backing?: ArtifactBacking
  readonly mediaType?: string
  readonly sizeBytes?: number
  readonly digest?: ContentDigest
  readonly git?: GitRefInput
  readonly createdAtMillis: number
}

export interface ArtifactContext {
  readonly swarmID: Swarm.ID
  readonly producerMemberID: Swarm.MemberID
  readonly workspace: WorkspaceProvenance
  readonly taskRunID?: Swarm.TaskRunID
  readonly deliverableID?: Swarm.DeliverableID
}

/**
 * Validates a declared artifact and derives its durability from the declared
 * backing. {@link ArtifactInput} deliberately carries no `durability` field, so
 * a caller cannot assert one at all; a stored row whose durability disagrees
 * with its backing is instead rejected by {@link assertDurableClaim} when it is
 * hydrated.
 */
export function validateArtifact(input: ArtifactInput, context: ArtifactContext) {
  return Effect.gen(function* () {
    const path = yield* normalizeLogicalPath(input.path)
    const backing = input.backing ?? "workspace_path"
    if (!Number.isInteger(input.createdAtMillis) || input.createdAtMillis < 0)
      return yield* invalid("Artifact creation time must be a non-negative epoch millisecond value.")
    if (input.sizeBytes !== undefined && (!Number.isInteger(input.sizeBytes) || input.sizeBytes < 0))
      return yield* invalid("Artifact sizeBytes must be a non-negative integer.")
    if (backing === "git_object" && !input.git) {
      return yield* invalid("A git_object artifact requires a commit/blob/patch reference.")
    }
    if (backing === "content_store" && (!input.digest || input.sizeBytes === undefined)) {
      return yield* invalid("A content_store artifact requires a content digest and byte size.")
    }
    const git = input.git
    if (git && !GIT_OBJECT.test(git.object)) {
      // Every git kind anchors to a content-addressable object id. Accepting a
      // free-form patch label would mint a `repository_durable` artifact whose
      // content identity nothing can verify, which is precisely the claim this
      // contract exists to prevent.
      return yield* invalid(`Artifact git ${git.kind} object must be a 40 character object id: ${git.object}`)
    }
    const gitPath = git?.path === undefined ? undefined : yield* normalizeLogicalPath(git.path)
    return Artifact.make({
      swarmID: context.swarmID,
      producerMemberID: context.producerMemberID,
      ...(context.taskRunID === undefined ? {} : { taskRunID: context.taskRunID }),
      ...(context.deliverableID === undefined ? {} : { deliverableID: context.deliverableID }),
      path,
      backing,
      durability: durabilityOf(backing),
      ...(input.mediaType === undefined ? {} : { mediaType: input.mediaType }),
      ...(input.sizeBytes === undefined ? {} : { sizeBytes: input.sizeBytes }),
      ...(input.digest === undefined ? {} : { digest: input.digest }),
      workspace: context.workspace,
      ...(git === undefined
        ? {}
        : {
            git: GitRef.make({
              kind: git.kind,
              object: git.object,
              ...(gitPath === undefined ? {} : { path: gitPath }),
            }),
          }),
      createdAtMillis: input.createdAtMillis,
    })
  })
}

/**
 * Hydration guard for durable artifact rows.
 *
 * A stored row must never be able to advertise durability its backing cannot
 * prove, otherwise a schema or migration edit could silently turn a path
 * reference into a claim that bytes are durable. Every read path that trusts a
 * persisted durability claim must run this first.
 */
export function assertDurableClaim(artifact: Artifact) {
  return Effect.gen(function* () {
    if (artifact.durability !== durabilityOf(artifact.backing)) {
      return yield* invalid(`Artifact durability ${artifact.durability} does not match backing ${artifact.backing}.`)
    }
    if (artifact.backing === "content_store" && (!artifact.digest || artifact.sizeBytes === undefined)) {
      return yield* invalid("A stored content_store artifact is missing its content identity.")
    }
    if (artifact.backing === "git_object" && !artifact.git) {
      return yield* invalid("A stored git_object artifact is missing its repository reference.")
    }
    if (artifact.backing === "workspace_path" && artifact.git) {
      return yield* invalid("A workspace_path artifact must not carry a repository reference.")
    }
    return artifact
  })
}

/**
 * Converts the legacy `Deliverable.files: string[]` shape into honest artifact
 * references. Legacy paths carry no content identity and therefore stay
 * `producer_workspace_only`; they must never be presented as durable bytes.
 */
export function artifactsFromPublishedPaths(
  paths: Iterable<string>,
  context: ArtifactContext & { readonly createdAtMillis: number },
) {
  return Effect.gen(function* () {
    const seen = new Set<string>()
    const artifacts: Array<Artifact> = []
    for (const candidate of paths) {
      if (artifacts.length >= MAX_ARTIFACTS_PER_DELIVERABLE) {
        return yield* invalid(`A deliverable may publish at most ${MAX_ARTIFACTS_PER_DELIVERABLE} artifacts.`)
      }
      const artifact = yield* validateArtifact({ path: candidate, createdAtMillis: context.createdAtMillis }, context)
      if (seen.has(artifact.path)) continue
      seen.add(artifact.path)
      artifacts.push(artifact)
    }
    return artifacts
  })
}

/**
 * How a consuming member can obtain the bytes. Decision-independent: it
 * describes the required action and whether the consumer must materialize the
 * content into its own workspace. It never claims success.
 */
export type ConsumePlan =
  | {
      readonly kind: "read_in_place"
      readonly path: LogicalPath
      readonly requiresMaterialization: false
    }
  | {
      readonly kind: "restore_from_git"
      readonly git: GitRef
      readonly requiresMaterialization: true
    }
  | {
      readonly kind: "fetch_from_content_store"
      readonly digest: ContentDigest
      readonly sizeBytes: number
      readonly requiresMaterialization: true
    }
  | {
      readonly kind: "unavailable"
      readonly reason: string
      readonly requiresMaterialization: true
    }

/**
 * Resolves consumption for one artifact from a consuming member's workspace.
 *
 * A path produced in a shared directory is readable in place. A path produced in
 * a worktree is NOT reachable from another workspace, so it fails closed with an
 * explicit reason instead of being handed over as if it existed.
 */
export function planConsume(artifact: Artifact, consumer: WorkspaceProvenance): ConsumePlan {
  // A backing that promises content-addressed bytes must never silently degrade
  // into a path read. If a stored row lost its reference, the honest answer is
  // `unavailable`: those bytes may only ever have existed in the producing
  // workspace, so handing back a path would invent reachability.
  if (artifact.backing === "git_object") {
    if (!artifact.git) {
      return {
        kind: "unavailable",
        reason: `Artifact ${artifact.path} claims a git_object backing without a repository reference and cannot be restored.`,
        requiresMaterialization: true,
      }
    }
    return { kind: "restore_from_git", git: artifact.git, requiresMaterialization: true }
  }
  if (artifact.backing === "content_store") {
    if (artifact.digest === undefined || artifact.sizeBytes === undefined) {
      return {
        kind: "unavailable",
        reason: `Artifact ${artifact.path} claims a content_store backing without content identity and cannot be located by digest.`,
        requiresMaterialization: true,
      }
    }
    return {
      kind: "fetch_from_content_store",
      digest: artifact.digest,
      sizeBytes: artifact.sizeBytes,
      requiresMaterialization: true,
    }
  }
  const sameWorkspace = artifact.workspace.directory === consumer.directory && artifact.workspace.kind === consumer.kind
  if (sameWorkspace) return { kind: "read_in_place", path: artifact.path, requiresMaterialization: false }
  return {
    kind: "unavailable",
    reason:
      `Artifact ${artifact.path} exists only in ${artifact.workspace.kind} workspace ` +
      `${artifact.workspace.directory}; it is not present in ${consumer.directory}. ` +
      "Publish it with a git_object or content_store backing to make it consumable.",
    requiresMaterialization: true,
  }
}

/** Bounded, human-facing projection. Never claims durability the artifact does not have. */
export function describeArtifact(artifact: Artifact) {
  const identity =
    artifact.digest === undefined
      ? "unverified content (no digest recorded)"
      : `${artifact.digest}${artifact.sizeBytes === undefined ? "" : ` (${artifact.sizeBytes} bytes)`}`
  const location =
    artifact.backing === "git_object" && artifact.git
      ? `git ${artifact.git.kind} ${artifact.git.object}`
      : artifact.backing === "content_store"
        ? "durable content store"
        : `workspace path in ${artifact.workspace.directory}`
  return `${artifact.path} [${artifact.durability}] ${location}; ${identity}`
}
