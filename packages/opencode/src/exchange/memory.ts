export * as ExchangeMemory from "./memory"

import { Effect, Schema } from "effect"
import { Memory } from "@opencode-ai/core/memory"
import { MemorySchema } from "@opencode-ai/core/memory/schema"
import { ExchangeError } from "./error"
import { ExchangeRuntimeV1 } from "./runtime-v1"

const KIND_VALUES = [
  "user_preference",
  "user_correction",
  "project_decision",
  "project_invariant",
  "workflow",
  "failure_pattern",
  "failed_approach",
  "environment_constraint",
  "reference",
] as const

const EvidenceInput = Schema.Struct({
  source_type: Schema.Literals([
    "user_message",
    "assistant_message",
    "tool_output",
    "git_commit",
    "git_diff",
    "file",
    "test_result",
    "session",
  ]).annotate({
    description: "What this memory is grounded in. Required for the memory to be active rather than quarantined.",
  }),
  session_id: Schema.optional(Schema.String),
  message_id: Schema.optional(Schema.String),
  part_id: Schema.optional(Schema.String),
  commit_sha: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  line_start: Schema.optional(Schema.Number),
  line_end: Schema.optional(Schema.Number),
  excerpt: Schema.optional(Schema.String).annotate({
    description: "Short quote or signal (max ~2000 chars). Never paste whole logs or diffs.",
  }),
})

export const Parameters = Schema.Struct({
  action: Schema.Literals(["map", "search", "open", "get", "timeline", "remember", "forget"]).annotate({
    description:
      "map = what memory exists · search = find compact routing hits · open = full topic view · get = one memory with evidence · timeline = supersession history · remember = persist durable experience · forget = tombstone",
  }),
  query: Schema.optional(Schema.String).annotate({
    description:
      "search: what to look for. Use real identifiers — symbols, paths, error codes, package names, commands. Lexical, so exact strings beat paraphrase.",
  }),
  topic: Schema.optional(Schema.String).annotate({
    description: "open: topic key from map/search. remember: topic to file under (default: general).",
  }),
  id: Schema.optional(Schema.String).annotate({
    description: "get/timeline/forget: memory id (mem_...). Accepts a unique prefix.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "timeline: stable key (e.g. test-runner) to show how a fact evolved.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))).annotate({
    description: "search: max hits (default 10)",
  }),
  kinds: Schema.optional(Schema.Array(Schema.Literals(KIND_VALUES))).annotate({
    description: "search: restrict to these memory kinds",
  }),
  scope: Schema.optional(Schema.Literals(["global", "project", "workspace"])).annotate({
    description:
      "search/remember: narrow to one scope. Omit for all scopes visible here. project is the safe default for code knowledge.",
  }),
  includeHistory: Schema.optional(Schema.Boolean).annotate({
    description: "search: include superseded and quarantined rows (default false)",
  }),
  content: Schema.optional(Schema.String).annotate({
    description: "remember: the durable fact or lesson, including WHY. One self-contained statement; no secrets.",
  }),
  title: Schema.optional(Schema.String).annotate({
    description: "remember: short label (auto-derived from content if omitted)",
  }),
  kind: Schema.optional(Schema.Literals(KIND_VALUES)).annotate({
    description: "remember: memory kind (default reference)",
  }),
  stableKey: Schema.optional(Schema.String).annotate({
    description:
      "remember: semantic slot (e.g. test-runner, package-manager). A new value SUPERSEDES the old instead of duplicating it.",
  }),
  evidence: Schema.optional(Schema.Array(EvidenceInput)).annotate({
    description:
      "remember: where this came from. At least one non-memory source is required or the memory is quarantined.",
  }),
  reason: Schema.optional(Schema.String).annotate({ description: "forget: why (recorded on the tombstone)" }),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export type Metadata = {
  action: string
  count?: number
  topics?: number
  topic?: string
  id?: string
  status?: string
  quarantined?: boolean
  truncated: boolean
}

export interface Result {
  readonly title: string
  readonly output: string
  readonly metadata: Metadata
  readonly structured: Readonly<Record<string, unknown>>
  readonly mutation: { readonly attempted: boolean; readonly committed: boolean }
}

export interface Hooks {
  readonly beforeMutation?: () => Effect.Effect<void, Error>
}

export interface RuntimeContext extends Hooks {
  readonly rootPath: string
  readonly signal?: AbortSignal
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

function iso(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const HINTS: Record<string, string> = {
  map: "Next: search with real identifiers, or open a topic.",
  search: "Next: open the topic for full context, or get an id for one memory plus its evidence.",
  open: "This is the current view. Superseded rows are history, not truth.",
  get: "Evidence tells you why this is believed. No evidence = ungrounded.",
  timeline: "Oldest first. The active row is current truth.",
  remember: "Stored. It will appear in map and search from now on.",
  forget: "Tombstoned and suppressed — background ingestion will not resurrect it.",
}

const renderHit = (hit: MemorySchema.SearchHit) => {
  const anchors = hit.anchors.length > 0 ? `\n    <anchors>${hit.anchors.map(escapeXml).join(", ")}</anchors>` : ""
  const flag = hit.status === "active" ? "" : ` status="${hit.status}"`
  return [
    `  <hit id="${hit.id}" score="${hit.score}"${flag}>`,
    `    <topic>${escapeXml(hit.topic_key)}</topic>`,
    `    <kind>${hit.kind}</kind><origin>${hit.origin}</origin><scope>${hit.scope}</scope>`,
    `    <title>${escapeXml(hit.title)}</title>`,
    `    <summary>${escapeXml(hit.snippet)}</summary>`,
    `    <evidence count="${hit.evidenceCount}" /><updated>${iso(hit.time_updated)}</updated>`,
    `  </hit>${anchors ? `\n  ${anchors.trim()}` : ""}`,
  ].join("\n")
}

function invalid(detail: string) {
  return new ExchangeError.InvalidArgument({ detail })
}

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<ExchangeError.Error>(new ExchangeError.Cancelled({ detail: "Memory operation was cancelled" }))
    : Effect.void
}

function mapMemoryError(error: unknown, signal?: AbortSignal): Error {
  if (
    error instanceof ExchangeError.InvalidArgument ||
    error instanceof ExchangeError.Cancelled ||
    error instanceof ExchangeError.NotFound ||
    error instanceof ExchangeError.Conflict ||
    error instanceof ExchangeError.AuthorityDenied ||
    error instanceof ExchangeError.PathEscape ||
    error instanceof ExchangeError.DependencyUnavailable ||
    error instanceof ExchangeError.AmbiguousCommit
  ) {
    return error
  }
  if (signal?.aborted) return new ExchangeError.Cancelled({ detail: "Memory operation was cancelled" })
  if (error && typeof error === "object") {
    const tagged = error as { _tag?: unknown; message?: unknown }
    const detail = typeof tagged.message === "string" && tagged.message ? tagged.message : "Memory operation failed"
    if (tagged._tag === "Memory.NotFoundError") return new ExchangeError.NotFound({ detail })
    if (tagged._tag === "Memory.ValidationError" || tagged._tag === "Memory.SecretDetectedError") {
      return new ExchangeError.InvalidArgument({ detail })
    }
  }
  return error instanceof Error
    ? new ExchangeError.DependencyUnavailable({ detail: error.message })
    : new ExchangeError.DependencyUnavailable({ detail: "OpenFork memory runtime is unavailable" })
}

const resolveID = (value: string | undefined) =>
  Effect.gen(function* () {
    if (!value?.trim()) {
      return yield* invalid('This action requires id (mem_...). Use action="search" to find ids.')
    }
    return value.trim()
  })

export function execute(
  memory: Memory.Interface,
  scope: MemorySchema.Context,
  params: Input,
  hooks: Hooks = {},
  signal?: AbortSignal,
): Effect.Effect<Result, Error> {
  return Effect.gen(function* () {
    yield* cancelled(signal)
    const action = params.action

    if (action === "map") {
      const [map, topics] = yield* Effect.all([memory.map(scope), memory.topics(scope)])
      const output = !map
        ? '<memory-map empty="true" />\nNo durable memory yet for this project.\nUse action="remember" to persist a decision, correction, or lesson worth keeping.'
        : `${map}\n\n${HINTS.map}`
      return {
        title: map ? `memory map (${topics.length} topics)` : "memory map",
        output,
        metadata: { action, topics: topics.length, truncated: false },
        structured: { action, map, topics },
        mutation: { attempted: false, committed: false },
      } satisfies Result
    }

    if (action === "search") {
      if (!params.query?.trim()) return yield* invalid('search requires query. Example: {"action":"search","query":"console-message electron"}')
      const hits = yield* memory.search({
        query: params.query,
        context: scope,
        scope: params.scope,
        kinds: params.kinds,
        limit: params.limit,
        includeHistory: params.includeHistory,
      })
      const output =
        hits.length === 0
          ? [
              `<memory-search query="${escapeXml(params.query)}" results="0" />`,
              "No match. Try: a real identifier (symbol, path, error code), a topic from map, or includeHistory:true for superseded rows.",
            ].join("\n")
          : [
              `<memory-search query="${escapeXml(params.query)}" results="${hits.length}">`,
              ...hits.map(renderHit),
              "</memory-search>",
              HINTS.search,
            ].join("\n")
      return {
        title: hits.length ? `memory search (${hits.length})` : "memory search",
        output,
        metadata: { action, count: hits.length, truncated: false },
        structured: { action, hits },
        mutation: { attempted: false, committed: false },
      } satisfies Result
    }

    if (action === "open") {
      if (!params.topic?.trim()) return yield* invalid('open requires topic. Use action="map" to list topics.')
      const view = yield* memory.open({ topic: params.topic, context: scope })
      return {
        title: `memory open ${params.topic}`,
        output: `${view}\n\n${HINTS.open}`,
        metadata: { action, topic: params.topic, truncated: false },
        structured: { action, topic: params.topic, view },
        mutation: { attempted: false, committed: false },
      } satisfies Result
    }

    if (action === "get") {
      const id = yield* resolveID(params.id)
      const entry = yield* memory.get({ id, context: scope })
      const evidence = yield* memory.evidence(entry.id)
      const output = [
        `<memory id="${entry.id}" status="${entry.status}">`,
        `  <topic>${escapeXml(entry.topic_key)}</topic>`,
        `  <kind>${entry.kind}</kind>`,
        `  <origin>${entry.origin}</origin>`,
        `  <scope>${entry.scope}</scope>`,
        `  <title>${escapeXml(entry.title)}</title>`,
        `  <content>${escapeXml(entry.content)}</content>`,
        `  <valid from="${iso(entry.valid_from)}"${entry.valid_to ? ` to="${iso(entry.valid_to)}"` : ""} />`,
        entry.superseded_by_id ? `  <superseded-by>${entry.superseded_by_id}</superseded-by>` : "",
        `  <evidence count="${evidence.length}">`,
        ...evidence.map(
          (item) =>
            `    <source type="${item.source_type}"${item.path ? ` path="${escapeXml(item.path)}"` : ""}${
              item.commit_sha ? ` commit="${escapeXml(item.commit_sha)}"` : ""
            }${item.session_id ? ` session="${escapeXml(item.session_id)}"` : ""} />`,
        ),
        "  </evidence>",
        "</memory>",
        evidence.length === 0
          ? "WARNING: no evidence. Treat as ungrounded and verify before relying on it."
          : HINTS.get,
      ]
        .filter((line) => line !== "")
        .join("\n")
      return {
        title: `memory get ${entry.id}`,
        output,
        metadata: { action, id: entry.id, status: entry.status, truncated: false },
        structured: { action, entry, evidence },
        mutation: { attempted: false, committed: false },
      } satisfies Result
    }

    if (action === "timeline") {
      if (!params.id?.trim() && !params.key?.trim()) {
        return yield* invalid('timeline requires id or key. Example: {"action":"timeline","key":"test-runner"}')
      }
      const id = params.id ? yield* resolveID(params.id) : undefined
      const entries = yield* memory.timeline({ id, key: params.key, context: scope })
      const output =
        entries.length === 0
          ? `<memory-timeline results="0" />\nNo history for ${params.id ?? params.key}.`
          : [
              `<memory-timeline of="${escapeXml(params.id ?? params.key ?? "")}">`,
              ...entries.map(
                (entry) =>
                  `  <row id="${entry.id}" status="${entry.status}" valid-from="${iso(entry.valid_from)}"${
                    entry.valid_to ? ` valid-to="${iso(entry.valid_to)}"` : ""
                  }>${escapeXml(entry.title)}</row>`,
              ),
              "</memory-timeline>",
              HINTS.timeline,
            ].join("\n")
      return {
        title: entries.length ? `memory timeline (${entries.length})` : "memory timeline",
        output,
        metadata: { action, count: entries.length, truncated: false },
        structured: { action, entries },
        mutation: { attempted: false, committed: false },
      } satisfies Result
    }

    if (action === "remember") {
      if (!params.content?.trim()) {
        return yield* invalid(
          'remember requires content. Example: {"action":"remember","content":"Electron console-message emits two signatures; normalize both.","kind":"environment_constraint","evidence":[{"source_type":"file","path":"packages/desktop/src/main/windows.ts"}]}',
        )
      }
      if (hooks.beforeMutation) yield* hooks.beforeMutation()
      yield* cancelled(signal)
      const entry = yield* memory.remember({
        context: scope,
        content: params.content,
        title: params.title,
        kind: params.kind,
        topic: params.topic,
        stableKey: params.stableKey,
        scope: params.scope,
        evidence: params.evidence,
      })
      const output =
        entry.status === "quarantined"
          ? [
              `<memory id="${entry.id}" status="quarantined" />`,
              "Stored but NOT active: no non-memory evidence was supplied, so it will not appear in search.",
              "Re-save with evidence:[{source_type:...}] citing a user message, tool output, git commit, test, or file.",
            ].join("\n")
          : [
              `<memory id="${entry.id}" status="${entry.status}">`,
              `  <topic>${escapeXml(entry.topic_key)}</topic>`,
              `  <kind>${entry.kind}</kind><origin>${entry.origin}</origin><scope>${entry.scope}</scope>`,
              `  <title>${escapeXml(entry.title)}</title>`,
              entry.supersedes_id ? `  <supersedes>${entry.supersedes_id}</supersedes>` : "",
              "</memory>",
              entry.supersedes_id
                ? "Superseded the previous value for this key. Old rows stay in timeline."
                : HINTS.remember,
            ]
              .filter((line) => line !== "")
              .join("\n")
      return {
        title: entry.status === "quarantined" ? "memory quarantined" : `memory remembered (${entry.topic_key})`,
        output,
        metadata: {
          action,
          id: entry.id,
          status: entry.status,
          ...(entry.status === "quarantined" ? { quarantined: true } : {}),
          truncated: false,
        },
        structured: { action, entry },
        mutation: { attempted: true, committed: true },
      } satisfies Result
    }

    const id = yield* resolveID(params.id)
    if (hooks.beforeMutation) yield* hooks.beforeMutation()
    yield* cancelled(signal)
    yield* memory.forget({ id, context: scope, reason: params.reason })
    return {
      title: `memory forgotten ${id}`,
      output: `<memory-forgotten id="${id}" />\n${HINTS.forget}`,
      metadata: { action, id, truncated: false },
      structured: { action, id, forgotten: true },
      mutation: { attempted: true, committed: true },
    } satisfies Result
  }).pipe(Effect.mapError((error) => mapMemoryError(error, signal)))
}

export function executeRuntime(input: Input, context: RuntimeContext): Effect.Effect<Result, Error> {
  return ExchangeRuntimeV1.enter(
    { directory: context.rootPath, signal: context.signal },
    async () => {
      const [{ Memory }, { MemorySchema }, { InstanceState }] = await Promise.all([
        import("@opencode-ai/core/memory"),
        import("@opencode-ai/core/memory/schema"),
        import("@/effect/instance-state"),
      ])
      return Effect.gen(function* () {
        const memory = yield* Memory.Service
        const instance = yield* InstanceState.context
        const workspaceID = yield* InstanceState.workspaceID
        const scope = MemorySchema.Context.make({
          projectID: instance.project.id,
          workspaceID: workspaceID ?? null,
        })
        return yield* execute(memory, scope, input, { beforeMutation: context.beforeMutation }, context.signal)
      })
    },
    "OpenFork memory runtime operation failed",
  )
}
