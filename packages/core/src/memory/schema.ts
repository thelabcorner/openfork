export * as MemorySchema from "./schema"

import { Schema } from "effect"
import { Identifier } from "../id/id"
import { Hash } from "../util/hash"

/**
 * Canonical vocabulary for the memory subsystem.
 *
 * Functional `Kind` and epistemic `Origin` are separate first-class fields:
 * `project_decision` + `user_stated` is a much stronger memory than the same
 * kind with `model_derived`, and retrieval/trust policy must be able to tell
 * them apart.
 */

export const ID = Schema.String.check(Schema.isStartsWith("mem")).pipe(Schema.brand("MemoryID"))
export type ID = typeof ID.Type

export const TopicID = Schema.String.check(Schema.isStartsWith("mtp")).pipe(Schema.brand("MemoryTopicID"))
export type TopicID = typeof TopicID.Type

export const EvidenceID = Schema.String.check(Schema.isStartsWith("mev")).pipe(Schema.brand("MemoryEvidenceID"))
export type EvidenceID = typeof EvidenceID.Type

export const nextID = () => ID.make(Identifier.ascending("memory"))
export const nextTopicID = () => TopicID.make(Identifier.ascending("memoryTopic"))
export const nextEvidenceID = () => EvidenceID.make(Identifier.ascending("memoryEvidence"))

/**
 * Deterministic dedupe key. Exact duplicates collapse to NOOP instead of
 * creating a second row.
 */
export function contentHash(input: { scope: string; kind: string; stableKey?: string | null; content: string }): string {
  const normalized = `${input.scope}|${input.kind}|${input.stableKey ?? ""}|${input.content.trim().replace(/\s+/g, " ").toLowerCase()}`
  return Hash.sha256(normalized)
}

/** Durable scopes. Retrieval specificity is workspace > project > global. */
export const Scope = Schema.Literals(["global", "project", "workspace"]).annotate({
  identifier: "MemoryScope",
})
export type Scope = typeof Scope.Type

export const Kind = Schema.Literals([
  "user_preference",
  "user_correction",
  "project_decision",
  "project_invariant",
  "workflow",
  "failure_pattern",
  "failed_approach",
  "environment_constraint",
  "reference",
]).annotate({ identifier: "MemoryKind" })
export type Kind = typeof Kind.Type

export const Origin = Schema.Literals([
  "user_stated",
  "tool_observed",
  "git_observed",
  "test_observed",
  "model_derived",
  "imported",
]).annotate({ identifier: "MemoryOrigin" })
export type Origin = typeof Origin.Type

export const Status = Schema.Literals(["active", "superseded", "quarantined", "tombstoned"]).annotate({
  identifier: "MemoryStatus",
})
export type Status = typeof Status.Type

export const AnchorKind = Schema.Literals([
  "symbol",
  "path",
  "error",
  "command",
  "package",
  "commit",
  "config",
  "identifier",
]).annotate({ identifier: "MemoryAnchorKind" })
export type AnchorKind = typeof AnchorKind.Type

export const EvidenceSource = Schema.Literals([
  "user_message",
  "assistant_message",
  "tool_output",
  "git_commit",
  "git_diff",
  "file",
  "test_result",
  "session",
  "external",
]).annotate({ identifier: "MemoryEvidenceSource" })
export type EvidenceSource = typeof EvidenceSource.Type

/** Non-memory evidence sources satisfy the recursive-contamination rule (INV-4). */
export const NON_MEMORY_SOURCES: ReadonlySet<EvidenceSource> = new Set<EvidenceSource>([
  "user_message",
  "assistant_message",
  "tool_output",
  "git_commit",
  "git_diff",
  "file",
  "test_result",
  "session",
])

export const Anchor = Schema.Struct({
  kind: AnchorKind,
  value: Schema.String,
  normalized: Schema.String,
}).annotate({ identifier: "MemoryAnchor" })
export type Anchor = typeof Anchor.Type

export const Evidence = Schema.Struct({
  id: EvidenceID,
  memory_id: ID,
  source_type: EvidenceSource,
  session_id: Schema.NullOr(Schema.String),
  message_id: Schema.NullOr(Schema.String),
  part_id: Schema.NullOr(Schema.String),
  commit_sha: Schema.NullOr(Schema.String),
  path: Schema.NullOr(Schema.String),
  line_start: Schema.NullOr(Schema.Number),
  line_end: Schema.NullOr(Schema.Number),
  source_hash: Schema.NullOr(Schema.String),
  observed_at: Schema.Number,
  excerpt: Schema.NullOr(Schema.String),
}).annotate({ identifier: "MemoryEvidence" })
export type Evidence = typeof Evidence.Type

export const Entry = Schema.Struct({
  id: ID,
  topic_id: TopicID,
  topic_key: Schema.String,
  topic_title: Schema.String,
  scope: Scope,
  project_id: Schema.NullOr(Schema.String),
  workspace_id: Schema.NullOr(Schema.String),
  kind: Kind,
  origin: Origin,
  stable_key: Schema.NullOr(Schema.String),
  title: Schema.String,
  content: Schema.String,
  status: Status,
  valid_from: Schema.Number,
  valid_to: Schema.NullOr(Schema.Number),
  supersedes_id: Schema.NullOr(ID),
  superseded_by_id: Schema.NullOr(ID),
  content_hash: Schema.String,
  time_created: Schema.Number,
  time_updated: Schema.Number,
  time_last_used: Schema.NullOr(Schema.Number),
  use_count: Schema.Number,
  /** Number of evidence rows backing this memory. Zero means ungrounded. */
  evidenceCount: Schema.Number,
}).annotate({ identifier: "MemoryEntry" })
export type Entry = typeof Entry.Type

/** Compact routing row returned by search. Detail is opened on demand. */
export const SearchHit = Schema.Struct({
  id: ID,
  topic_key: Schema.String,
  topic_title: Schema.String,
  kind: Kind,
  origin: Origin,
  scope: Scope,
  title: Schema.String,
  snippet: Schema.String,
  status: Status,
  evidenceCount: Schema.Number,
  anchors: Schema.Array(Schema.String),
  time_updated: Schema.Number,
  score: Schema.Number,
}).annotate({ identifier: "MemorySearchHit" })
export type SearchHit = typeof SearchHit.Type

export const Topic = Schema.Struct({
  id: TopicID,
  scope: Scope,
  project_id: Schema.NullOr(Schema.String),
  workspace_id: Schema.NullOr(Schema.String),
  key: Schema.String,
  title: Schema.String,
  description: Schema.String,
  pinned: Schema.Boolean,
  entryCount: Schema.Number,
  time_updated: Schema.Number,
}).annotate({ identifier: "MemoryTopic" })
export type Topic = typeof Topic.Type

export const Context = Schema.Struct({
  projectID: Schema.String,
  workspaceID: Schema.NullOr(Schema.String),
}).annotate({ identifier: "MemoryContext" })
export type Context = typeof Context.Type

export const SearchInput = Schema.Struct({
  query: Schema.String,
  context: Context,
  scope: Schema.optional(Scope),
  kinds: Schema.optional(Schema.Array(Kind)),
  limit: Schema.optional(Schema.Number),
  /** Include superseded/quarantined rows. Default false (current truth only). */
  includeHistory: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "MemorySearchInput" })
export type SearchInput = typeof SearchInput.Type

export const RememberInput = Schema.Struct({
  context: Context,
  content: Schema.String,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Kind),
  topic: Schema.optional(Schema.String),
  stableKey: Schema.optional(Schema.String),
  scope: Schema.optional(Scope),
  evidence: Schema.optional(
    Schema.Array(
      Schema.Struct({
        source_type: EvidenceSource,
        session_id: Schema.optional(Schema.String),
        message_id: Schema.optional(Schema.String),
        part_id: Schema.optional(Schema.String),
        commit_sha: Schema.optional(Schema.String),
        path: Schema.optional(Schema.String),
        line_start: Schema.optional(Schema.Number),
        line_end: Schema.optional(Schema.Number),
        source_hash: Schema.optional(Schema.String),
        excerpt: Schema.optional(Schema.String),
      }),
    ),
  ),
}).annotate({ identifier: "MemoryRememberInput" })
export type RememberInput = typeof RememberInput.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Memory.NotFoundError", {
  id: Schema.String,
}) {
  override get message() {
    return `Memory ${this.id} was not found in the active scope.`
  }
}

export class ValidationError extends Schema.TaggedErrorClass<ValidationError>()("Memory.ValidationError", {
  reason: Schema.String,
}) {
  override get message() {
    return `Memory operation rejected: ${this.reason}`
  }
}

/** Rejected when content trips the deterministic secret scanner. */
export class SecretDetectedError extends Schema.TaggedErrorClass<SecretDetectedError>()(
  "Memory.SecretDetectedError",
  { findings: Schema.Array(Schema.String) },
) {
  override get message() {
    return `Refusing to persist memory containing credential-like content: ${this.findings.join(", ")}`
  }
}
