export * as Memory from "./index"

import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Context, Scope } from "effect"
import { Database } from "../database/database"
import { Flag } from "../flag/flag"
import { makeLocationNode } from "../effect/app-node"
import { MemoryAnchors } from "./anchors"
import { MemoryProjection } from "./projection"
import { MemorySecrets } from "./secrets"
import { MemoryStore } from "./store"
import { MemorySchema } from "./schema"

/**
 * Memory domain service.
 *
 * Governing rule (the security boundary): memory is evidence-bearing context,
 * not authority. Recalled memory may guide investigation, but it must never
 * silently become the sole evidence for new durable memory.
 *
 * Read path: scoped search -> compact routing rows -> open detail on demand.
 * There is deliberately no "inject top-k into every prompt" path (INV-7).
 */

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 50
const MAX_CONTENT = 8000
const MAX_TITLE = 200
const DEFAULT_TOPIC = "general"

/** Topic keys seeded for every project so the map is never empty. */
const SEED_TOPICS: ReadonlyArray<{ key: string; title: string; description: string }> = [
  { key: "architecture", title: "Architecture", description: "Structure, boundaries, and design rationale." },
  { key: "workflows", title: "Workflows", description: "Build, test, release, and repo conventions." },
  { key: "known-failures", title: "Known failures", description: "Rejected approaches and recurring regressions." },
  { key: "user-corrections", title: "User corrections", description: "Explicit corrections of agent behavior." },
]

export type MemoryError =
  | MemorySchema.NotFoundError
  | MemorySchema.ValidationError
  | MemorySchema.SecretDetectedError

export interface Interface {
  readonly map: (context: MemorySchema.Context) => Effect.Effect<string>
  readonly topics: (context: MemorySchema.Context) => Effect.Effect<MemorySchema.Topic[]>
  readonly search: (input: MemorySchema.SearchInput) => Effect.Effect<MemorySchema.SearchHit[]>
  readonly get: (input: {
    id: string
    context: MemorySchema.Context
  }) => Effect.Effect<MemorySchema.Entry, MemorySchema.NotFoundError>
  readonly evidence: (id: string) => Effect.Effect<MemorySchema.Evidence[]>
  readonly timeline: (input: {
    id?: string
    key?: string
    context: MemorySchema.Context
  }) => Effect.Effect<MemorySchema.Entry[]>
  readonly open: (input: {
    topic: string
    context: MemorySchema.Context
  }) => Effect.Effect<string, MemorySchema.NotFoundError>
  readonly remember: (
    input: MemorySchema.RememberInput,
  ) => Effect.Effect<MemorySchema.Entry, MemorySchema.ValidationError | MemorySchema.SecretDetectedError>
  readonly forget: (input: {
    id: string
    context: MemorySchema.Context
    reason?: string
  }) => Effect.Effect<void, MemorySchema.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Memory") {}

    const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MemoryStore.Service
    const projection = yield* MemoryProjection.Service
    // Usage accounting must never sit on the read critical path. Forked into
    // the layer scope so it cannot outlive the service (Effect v4 has no
    // forkDaemon).
    const scope = yield* Scope.Scope

    /**
     * Scope predicate. Applied BEFORE ranking so a memory from another project
     * can never surface (INV-1). Explicit `scope` narrows further; omission
     * means "every scope visible to this context", still hard-filtered.
     */
    const scopeClause = (context: MemorySchema.Context, scope?: MemorySchema.Scope): SQL => {
      const clauses: SQL[] = []
      const includeGlobal = scope === undefined || scope === "global"
      const includeProject = scope === undefined || scope === "project"
      const includeWorkspace = scope === undefined || scope === "workspace"

      if (includeGlobal) clauses.push(sql`(e.scope = 'global' AND e.project_id IS NULL)`)
      if (includeProject) clauses.push(sql`(e.scope = 'project' AND e.project_id = ${context.projectID})`)
      if (includeWorkspace && context.workspaceID)
        clauses.push(sql`(e.scope = 'workspace' AND e.workspace_id = ${context.workspaceID})`)
      if (clauses.length === 0) return sql`1 = 0`
      return sql`(${sql.join(clauses, sql` OR `)})`
    }

    const seedTopics = Effect.fn("Memory.seedTopics")(function* (context: MemorySchema.Context) {
      for (const topic of SEED_TOPICS) {
        yield* store.upsertTopic({
          scope: "project",
          projectID: context.projectID,
          workspaceID: null,
          key: topic.key,
          title: topic.title,
          description: topic.description,
        })
      }
    })

    const map = Effect.fn("Memory.map")(function* (context: MemorySchema.Context) {
      if (!enabled()) return yield* Effect.succeed("")
      yield* seedTopics(context)
      const topics = yield* store.topics(context)
      const rendered = MemoryProjection.renderMap(topics)
      return rendered.length === 0 ? "" : rendered
    })

    const topics = Effect.fn("Memory.topics")(function* (context: MemorySchema.Context) {
      yield* seedTopics(context)
      return yield* store.topics(context)
    })

    const search = Effect.fn("Memory.search")(function* (input: MemorySchema.SearchInput) {
      if (!enabled()) return [] as MemorySchema.SearchHit[]
      const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT)
      const match = MemoryAnchors.matchQuery(input.query)
      const terms = MemoryAnchors.queryTerms(input.query)
      if (!match) return [] as MemorySchema.SearchHit[]

      // Rank in the FTS layer first (narrow rowid+score rows), then join only
      // the top-N. The scope filter is applied BEFORE ranking by intersecting
      // FTS matches with scoped rowids, so bm25 sort stays bounded by the
      // scoped set and cross-project rows can never enter the ranking.
      const ranked = sql`
        SELECT f.rowid AS rowid, bm25(memory_entry_fts) AS score
        FROM memory_entry_fts f
        JOIN (
          SELECT e.rowid
          FROM memory_entry e
          WHERE ${scopeClause(input.context, input.scope)}
            AND e.status = 'active'
        ) scoped ON scoped.rowid = f.rowid
        WHERE memory_entry_fts MATCH ${match}
        ORDER BY bm25(memory_entry_fts)
        LIMIT ${limit * 4}`
      const anchors = MemoryAnchors.extract(input.query).map((anchor) => anchor.normalized)

      const rows = yield* store.searchRanked({
        ranked,
        anchors,
        kinds: input.kinds ? [...input.kinds] : undefined,
        includeHistory: input.includeHistory ?? false,
        limit,
      })

      // Bump usage off the read critical path (no write amplification per open).
      yield* store.touch(rows.map((row) => row.id)).pipe(
        Effect.ignore,
        Effect.forkIn(scope),
      )

      return rows
    })

    const get = Effect.fn("Memory.get")(function* (input: { id: string; context: MemorySchema.Context }) {
      const entry = yield* store.get(input.id)
      if (!entry) return yield* new MemorySchema.NotFoundError({ id: input.id })
      if (!visible(entry, input.context)) return yield* new MemorySchema.NotFoundError({ id: input.id })
      yield* store.touch([entry.id]).pipe(Effect.ignore, Effect.forkIn(scope))
      return entry
    })

    const evidence = Effect.fn("Memory.evidence")(function* (id: string) {
      return yield* store.evidence(id)
    })

    const timeline = Effect.fn("Memory.timeline")(function* (input: {
      id?: string
      key?: string
      context: MemorySchema.Context
    }) {
      return yield* store.timeline({
        id: input.id,
        key: input.key,
        projectID: input.context.projectID,
        workspaceID: input.context.workspaceID,
      })
    })

    const open = Effect.fn("Memory.open")(function* (input: { topic: string; context: MemorySchema.Context }) {
      const topic = yield* store.topicByKey(input.context, input.topic)
      if (!topic) {
        const available = (yield* store.topics(input.context)).map((item) => item.key)
        return yield* new MemorySchema.NotFoundError({
          id: available.length ? `${input.topic} (available: ${available.join(", ")})` : input.topic,
        })
      }
      return yield* projection.render(topic)
    })

    const remember = Effect.fn("Memory.remember")(function* (input: MemorySchema.RememberInput) {
      if (!enabled()) {
        return yield* new MemorySchema.ValidationError({ reason: "memory is disabled" })
      }

      const content = input.content.trim()
      if (!content) {
        return yield* new MemorySchema.ValidationError({ reason: "content is required" })
      }
      if (content.length > MAX_CONTENT) {
        return yield* new MemorySchema.ValidationError({
          reason: `content exceeds ${MAX_CONTENT} characters (got ${content.length})`,
        })
      }

      // Deterministic secret scan runs before any model- or caller-supplied
      // content reaches durable storage. Fail closed.
      const scan = MemorySecrets.scan(`${input.title ?? ""}\n${content}`)
      if (!scan.clean) {
        return yield* new MemorySchema.SecretDetectedError({ findings: [...scan.findings] })
      }

      // Reject attempts to smuggle instructions into durable memory.
      if (looksLikeInjection(content)) {
        return yield* new MemorySchema.ValidationError({
          reason: "content looks like instructions rather than observed experience; memory stores evidence, not policy",
        })
      }

      const scope = input.scope ?? "project"
      const kind = input.kind ?? "reference"
      const title = (input.title ?? titleFrom(content)).slice(0, MAX_TITLE)
      const key = normalizeTopicKey(input.topic ?? DEFAULT_TOPIC)
      const evidence = input.evidence ?? []

      // INV-4: an active memory needs at least one non-memory source. Without
      // one it is stored quarantined (never entering normal recall) rather than
      // rejected outright, so the model can still see what it tried to save.
      const grounded = evidence.some((item) => MemorySchema.NON_MEMORY_SOURCES.has(item.source_type))
      const origin: MemorySchema.Origin = grounded
        ? sourceOrigin(evidence)
        : "model_derived"
      const status: MemorySchema.Status = grounded ? "active" : "quarantined"

      const topic = yield* store.upsertTopic({
        scope,
        projectID: scope === "global" ? null : input.context.projectID,
        workspaceID: scope === "workspace" ? input.context.workspaceID : null,
        key,
        title: humanize(key),
        description: "",
      })

      const anchors = MemoryAnchors.extract(`${title}\n${content}`)
      const hash = MemorySchema.contentHash({ scope, kind, stableKey: input.stableKey, content })

      // Exact duplicate in the same slot is a NOOP, not a second row.
      const existing = yield* store.findByHash({ scope, hash })
      if (existing) return existing

      const entry = yield* store.insert({
        scope,
        kind,
        origin,
        status,
        topic,
        title,
        content,
        hash,
        anchors,
        // Scope identity must be persisted alongside the row, otherwise a
        // project-scoped memory can never be matched by the scope filter.
        projectID: scope === "global" ? null : input.context.projectID,
        workspaceID: scope === "workspace" ? input.context.workspaceID : null,
        stableKey: input.stableKey ?? null,
        evidence: evidence.map((item) => ({
          source_type: item.source_type,
          session_id: item.session_id ?? null,
          message_id: item.message_id ?? null,
          part_id: item.part_id ?? null,
          commit_sha: item.commit_sha ?? null,
          path: item.path ?? null,
          line_start: item.line_start ?? null,
          line_end: item.line_end ?? null,
          source_hash: item.source_hash ?? null,
          excerpt: item.excerpt?.slice(0, 2000) ?? null,
        })),
        // A new keyed fact supersedes the previous one instead of silently
        // overwriting it (INV-8): history stays reachable via timeline.
        supersedeKey: input.stableKey ?? undefined,
      }).pipe(Effect.mapError(asMemoryError))

      yield* store.markTopicDirty(topic.id).pipe(Effect.mapError(asMemoryError))
      return entry
    })

    const forget = Effect.fn("Memory.forget")(function* (input: {
      id: string
      context: MemorySchema.Context
      reason?: string
    }) {
      const entry = yield* store.get(input.id)
      if (!entry) return yield* new MemorySchema.NotFoundError({ id: input.id })
      if (!visible(entry, input.context)) return yield* new MemorySchema.NotFoundError({ id: input.id })
      // Tombstone + suppression: without the suppression row the next
      // background pass over the same old session would resurrect the memory.
      yield* store.tombstone(entry, input.reason).pipe(Effect.orDie)
    })

    return Service.of({ map, topics, search, get, evidence, timeline, open, remember, forget })
  }),
)

function visible(entry: MemorySchema.Entry, context: MemorySchema.Context): boolean {
  if (entry.scope === "global") return true
  if (entry.scope === "project") return entry.project_id === context.projectID
  return entry.workspace_id !== null && entry.workspace_id === context.workspaceID
}

function sourceOrigin(evidence: ReadonlyArray<{ source_type: MemorySchema.EvidenceSource }>): MemorySchema.Origin {
  const types = new Set(evidence.map((item) => item.source_type))
  if (types.has("user_message")) return "user_stated"
  if (types.has("test_result")) return "test_observed"
  if (types.has("git_commit") || types.has("git_diff")) return "git_observed"
  if (types.has("file")) return "imported"
  return "tool_observed"
}

/** Storage-layer failures surface as validation errors, not defects. */
function asMemoryError(error: unknown): MemorySchema.ValidationError {
  return new MemorySchema.ValidationError({
    reason: error instanceof Error ? error.message : String(error),
  })
}

const INJECTION = /(?:\bignore\b(?:\s+(?:all|any|previous|above|prior))?\s+(?:previous|above|prior|all)\b|\byou\s+are\s+now\b|\bsystem\s*:\s*|\bnew\s+instructions?\b|\bdisregard\b.{0,20}\binstructions?\b)/i

function looksLikeInjection(content: string): boolean {
  return INJECTION.test(content)
}

function titleFrom(content: string): string {
  const first = content.split(/\r?\n/).find((line) => line.trim().length > 0) ?? content
  const sentence = first.trim().split(/(?<=[.!?])\s/)[0] ?? first.trim()
  return sentence.length > MAX_TITLE ? `${sentence.slice(0, MAX_TITLE - 1)}…` : sentence
}

function normalizeTopicKey(input: string): string {
  const key = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
  return key || DEFAULT_TOPIC
}

function humanize(key: string): string {
  return key
    .split("-")
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ")
}

export function enabled(): boolean {
  return !Flag.OPENCODE_DISABLE_MEMORY
}

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, MemoryStore.node, MemoryProjection.node],
})
