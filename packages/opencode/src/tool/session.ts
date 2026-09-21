import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./session.txt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Project } from "@/project/project"
import { SessionID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "get", "status", "messages"]).annotate({
    description: "Action to perform",
  }),
  sessionId: Schema.optional(Schema.String).annotate({ description: "Target session ID for get/status/messages" }),
  scope: Schema.optional(Schema.Literals(["current", "project", "global"])).annotate({
    description: "list: current (default), project, or global",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max items to return (default 10, max 100)",
  }),
  search: Schema.optional(Schema.String).annotate({ description: "list: title search substring" }),
  roots: Schema.optional(Schema.Boolean).annotate({ description: "list: only root sessions (parentID null)" }),
  parentId: Schema.optional(Schema.String).annotate({
    description:
      "list: only sessions with this parent — finds subagent/task child sessions (e.g. to recover a failed task)",
  }),
  includeArchived: Schema.optional(Schema.Boolean).annotate({ description: "list: include archived sessions" }),
  withStatus: Schema.optional(Schema.Boolean).annotate({ description: "list: attach live status per session" }),
  role: Schema.optional(Schema.Literals(["all", "user", "assistant"])).annotate({
    description: "messages: filter by role (default all)",
  }),
  last: Schema.optional(Schema.Boolean).annotate({ description: "messages: return only the last matching message" }),
  includeSynthetic: Schema.optional(Schema.Boolean).annotate({
    description: "messages: include host-owned synthetic turns and synthetic text parts",
  }),
  wait: Schema.optional(Schema.Boolean).annotate({
    description: "messages: wait for the target Session to become idle before reading",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "messages wait timeout in seconds (default 600, max 86400)",
  }),
})

type Metadata = {
  action: string
  count?: number
  scope?: string
  sessionId?: string
  paused?: boolean
  truncated?: boolean
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined) return fallback
  const n = Math.floor(limit)
  if (n < 1) return 1
  if (n > 100) return 100
  return n
}

function normalizeTimeout(timeout: number | undefined): number {
  const fallback = 600
  if (timeout === undefined) return fallback
  const n = Math.floor(timeout)
  if (n < 1) return 1
  if (n > 86400) return 86400
  return n
}

type AgentSessionSummary = {
  id: string
  title: string
  projectID: string
  directory: string
  parentID?: string
  workspaceID?: string
  agent?: string
  model?: string
  variant?: string
  status?: string
  paused: boolean
  archived: boolean
  cost: number
  tokens: {
    input: number
    output: number
    reasoning: number
    cacheRead: number
    cacheWrite: number
  }
  createdAt: number
  updatedAt: number
}

function projectSession(session: Session.Info, status?: string): AgentSessionSummary {
  const model = session.model ? `${session.model.providerID}/${session.model.id}` : undefined
  const variant = session.model?.variant && session.model.variant !== "default" ? session.model.variant : undefined
  const summary: AgentSessionSummary = {
    id: session.id,
    title: session.title,
    projectID: session.projectID,
    directory: session.directory,
    ...(session.parentID ? { parentID: session.parentID } : {}),
    ...(session.workspaceID ? { workspaceID: session.workspaceID } : {}),
    ...(session.agent ? { agent: session.agent } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    ...(status ? { status } : {}),
    paused: session.pausedAt !== undefined,
    archived: session.time.archived !== undefined && session.time.archived !== null,
    cost: session.cost ?? 0,
    tokens: {
      input: session.tokens?.input ?? 0,
      output: session.tokens?.output ?? 0,
      reasoning: session.tokens?.reasoning ?? 0,
      cacheRead: session.tokens?.cache?.read ?? 0,
      cacheWrite: session.tokens?.cache?.write ?? 0,
    },
    createdAt: session.time.created,
    updatedAt: session.time.updated,
  }
  return summary
}

type AgentSessionMessage = {
  id: string
  role: "user" | "assistant"
  kind: SessionTurnProvenance.SemanticKind
  owner?: "user" | "host"
  source?: string
  createdAt: number
  completedAt?: number
  agent?: string
  model?: string
  variant?: string
  synthetic?: boolean
  text: string
}

// Role/kind filtering can skip large runs of host Synthetic traffic. Never
// answer a small agent-facing request by hydrating an arbitrarily large Session
// history: one larger bounded retry is enough, and the result reports when the
// scan ceiling prevented proving completeness.
export const MESSAGE_SCAN_LIMIT = 2_000

function extractAgentMessage(message: SessionV1.WithParts, includeSynthetic: boolean): AgentSessionMessage | undefined {
  const info = message.info as any
  if (info.role !== "user" && info.role !== "assistant") return undefined
  const provenance = SessionTurnProvenance.resolve(message)
  const kind = SessionTurnProvenance.semanticKind(message)
  if (!includeSynthetic && kind === "synthetic") return undefined
  const textParts: Array<{ text: string; synthetic?: boolean }> = []
  for (const part of message.parts) {
    if (part.type !== "text") continue
    const synthetic = (part as any).synthetic === true
    if (!includeSynthetic && synthetic) continue
    const text = (part as any).text ?? ""
    if (text === "") continue
    textParts.push({ text, synthetic })
  }
  if (textParts.length === 0) return undefined
  const text = textParts.map((p) => p.text).join("\n")
  if (text.trim() === "") return undefined
  const hasSynthetic = textParts.some((p) => p.synthetic)
  const allSynthetic = textParts.every((p) => p.synthetic)
  let agent: string | undefined
  let model: string | undefined
  let variant: string | undefined
  if (info.role === "user") {
    agent = info.agent
    if (info.model) {
      model = `${info.model.providerID}/${info.model.modelID}`
      variant = info.model.variant && info.model.variant !== "default" ? info.model.variant : undefined
    }
  } else {
    agent = info.agent
    if (info.providerID && info.modelID) {
      model = `${info.providerID}/${info.modelID}`
      variant = info.variant && info.variant !== "default" ? info.variant : undefined
    }
  }
  const result: AgentSessionMessage = {
    id: info.id,
    role: info.role,
    kind,
    ...(provenance ? { owner: provenance.owner, source: provenance.source } : {}),
    createdAt: info.time?.created ?? 0,
    ...(info.time?.completed ? { completedAt: info.time.completed } : {}),
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(variant ? { variant } : {}),
    text,
  }
  if (includeSynthetic) {
    if (allSynthetic) (result as any).synthetic = true
    else if (hasSynthetic) (result as any).containsSynthetic = true
  }
  return result
}

function titleFor(action: string): string {
  switch (action) {
    case "list":
      return "List sessions"
    case "get":
      return "View session"
    case "status":
      return "Check session status"
    case "messages":
      return "Read session messages"
    default:
      return "Session"
  }
}

const validateActionParams = Effect.fn("SessionTool.validateActionParams")(function* (
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const action = params.action
  if (action === "get" || action === "status" || action === "messages") {
    if (!params.sessionId) return yield* Effect.fail(new Error(`sessionId is required for ${action}`))
  }
  if (params.last === true && params.limit !== undefined) {
    return yield* Effect.fail(new Error("last cannot be combined with limit"))
  }
  if (params.timeout !== undefined && params.wait !== true) {
    return yield* Effect.fail(new Error("timeout requires wait"))
  }
  if (params.scope !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("scope is only valid for list"))
  }
  if (params.withStatus !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("withStatus is only valid for list"))
  }
  if (params.search !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("search is only valid for list"))
  }
  if (params.roots !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("roots is only valid for list"))
  }
  if (params.includeArchived !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("includeArchived is only valid for list"))
  }
  if (params.parentId !== undefined && action !== "list") {
    return yield* Effect.fail(new Error("parentId is only valid for list"))
  }
  if (params.parentId !== undefined && params.roots === true) {
    return yield* Effect.fail(new Error("parentId cannot be combined with roots"))
  }
  if (params.role !== undefined && action !== "messages") {
    return yield* Effect.fail(new Error("role is only valid for messages"))
  }
  if (params.includeSynthetic !== undefined && action !== "messages") {
    return yield* Effect.fail(new Error("includeSynthetic is only valid for messages"))
  }
  if (params.wait === true) {
    if (action !== "messages") return yield* Effect.fail(new Error("wait is only valid for messages"))
    const t = normalizeTimeout(params.timeout)
    if (t > 86400) return yield* Effect.fail(new Error("timeout must be <= 86400"))
  }
})

export const SessionTool = Tool.define<typeof Parameters, Metadata, Session.Service | SessionStatus.Service | Project.Service>(
  "session",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const projects = yield* Project.Service

    const inDirectory = <A, E, R>(directory: string, effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const current = yield* InstanceState.context
        if (current.directory === directory) return yield* effect
        const resolved = yield* projects.fromDirectory(directory)
        const target = {
          directory,
          worktree: resolved.sandbox,
          project: resolved.project,
        }
        return yield* effect.pipe(Effect.provideService(InstanceRef, target))
      })

    const list = Effect.fn("SessionTool.list")(function* (params: Schema.Schema.Type<typeof Parameters>) {
      const current = yield* InstanceState.context
      const scopeVal = params.scope ?? "current"
      const limit = normalizeLimit(params.limit, 10)
      const parentID = params.parentId !== undefined ? SessionID.make(params.parentId) : undefined
      let rows: Session.Info[] = []
      if (scopeVal === "global") {
        const globalRows = yield* sessions
          .listGlobal({
            limit,
            search: params.search?.trim() || undefined,
            parentID,
            roots: params.roots,
            archived: params.includeArchived === true,
          })
          .pipe(Effect.orDie)
        rows = globalRows.map((r: any) => ({
          id: r.id,
          slug: r.slug,
          projectID: r.projectID,
          workspaceID: r.workspaceID,
          directory: r.directory,
          path: r.path,
          parentID: r.parentID,
          title: r.title,
          agent: r.agent,
          model: r.model,
          version: r.version,
          cost: r.cost,
          tokens: r.tokens,
          time: r.time,
          pausedAt: r.pausedAt,
          metadata: r.metadata,
          permission: r.permission,
          share: r.share,
          summary: r.summary,
          revert: r.revert,
        }))
      } else if (scopeVal === "project") {
        rows = yield* sessions
          .list({
            scope: "project",
            limit,
            search: params.search?.trim() || undefined,
            parentID,
            roots: params.roots,
          })
          .pipe(Effect.orDie)
        if (!params.includeArchived) rows = rows.filter((s) => !s.time.archived)
      } else {
        rows = yield* sessions
          .list({
            directory: current.directory,
            limit,
            search: params.search?.trim() || undefined,
            parentID,
            roots: params.roots,
          })
          .pipe(Effect.orDie)
        if (!params.includeArchived) rows = rows.filter((s) => !s.time.archived)
      }

      if (!params.withStatus) {
        const sessionsOut = rows.map((s) => projectSession(s))
        return {
          title: "List sessions",
          output: JSON.stringify({ scope: scopeVal, sessions: sessionsOut }),
          metadata: { action: "list", count: sessionsOut.length, scope: scopeVal },
        }
      }

      const groups = new Map<string, Session.Info[]>()
      for (const s of rows) {
        const arr = groups.get(s.directory)
        if (arr) arr.push(s)
        else groups.set(s.directory, [s])
      }
      const uniqueDirs = [...groups.keys()]
      const statusByDirectory = new Map<string, Map<SessionID, SessionStatus.Info> | null>()
      yield* Effect.forEach(
        uniqueDirs,
        (dir) =>
          inDirectory(dir, statuses.list())
            .pipe(
              Effect.map((mp) => {
                statusByDirectory.set(dir, mp)
              }),
              Effect.catch(() =>
                Effect.sync(() => {
                  statusByDirectory.set(dir, null)
                }),
              ),
            ),
        { concurrency: 4 },
      )
      const sessionsOut = rows.map((s) => {
        const mp = statusByDirectory.get(s.directory)
        let st: string | undefined
        if (mp === null) st = "unknown"
        else if (mp) {
          const v = mp.get(s.id as SessionID)
          st = v ? (v.type as string) : "idle"
        } else st = "unknown"
        return projectSession(s, st)
      })
      return {
        title: "List sessions",
        output: JSON.stringify({ scope: scopeVal, sessions: sessionsOut }),
        metadata: { action: "list", count: sessionsOut.length, scope: scopeVal },
      }
    })

    const status = Effect.fn("SessionTool.status")(function* (params: Schema.Schema.Type<typeof Parameters>) {
      const id = SessionID.make(params.sessionId!)
      const session = yield* sessions.get(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )
      const st = yield* inDirectory(
        session.directory,
        statuses.get(id).pipe(Effect.catch(() => Effect.succeed({ type: "unknown" as const }))),
      ).pipe(Effect.orDie)
      const paused = session.pausedAt !== undefined
      return {
        title: "Check session status",
        output: JSON.stringify({ sessionId: session.id, directory: session.directory, status: st, paused }),
        metadata: { action: "status", sessionId: session.id, paused },
      }
    })

    const messages = Effect.fn("SessionTool.messages")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const id = SessionID.make(params.sessionId!)
      const session = yield* sessions.get(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )

      if (params.wait === true) {
        const timeoutSec = normalizeTimeout(params.timeout)
        const start = Date.now()
        while (true) {
          const st = yield* inDirectory(
            session.directory,
            statuses.get(id).pipe(Effect.catch(() => Effect.succeed({ type: "idle" as const }))),
          ).pipe(Effect.orDie)
          if (st.type === "idle") break
          if (Date.now() - start > timeoutSec * 1000) {
            return yield* Effect.fail(new Error(`Timeout waiting for session ${params.sessionId} to become idle`))
          }
          if (ctx.abort.aborted) {
            return yield* Effect.fail(new Error("Cancelled while waiting for session"))
          }
          yield* Effect.sleep("200 millis")
        }
      }

      const limit = normalizeLimit(params.limit, 10)
      const role = params.role ?? "all"
      const includeSynthetic = params.includeSynthetic ?? false
      const fetchLimit = role === "all" ? limit : Math.max(100, limit * 4)

      const toAgent = (msgs: SessionV1.WithParts[]) =>
        msgs
          .map((m) => extractAgentMessage(m, includeSynthetic))
          .filter((m): m is AgentSessionMessage => m !== undefined)
          .filter((m) => {
            if (role === "all") return true
            if (role === "user") return m.kind === "user"
            return m.kind === "assistant"
          })

      let raw = yield* sessions.messages({ sessionID: id, limit: fetchLimit }).pipe(Effect.orDie)
      let filtered = toAgent(raw)
      let truncated = false
      if (filtered.length < limit && raw.length >= fetchLimit) {
        const scanLimit = Math.max(fetchLimit, MESSAGE_SCAN_LIMIT)
        raw = yield* sessions.messages({ sessionID: id, limit: scanLimit }).pipe(Effect.orDie)
        filtered = toAgent(raw)
        truncated = filtered.length < limit && raw.length >= scanLimit
      }

      let result: AgentSessionMessage[]
      if (params.last === true) {
        result = filtered.slice(-1)
      } else {
        result = filtered.slice(-limit)
      }

      const st = yield* inDirectory(
        session.directory,
        statuses.get(id).pipe(Effect.catch(() => Effect.succeed({ type: "idle" as const }))),
      ).pipe(Effect.orDie)

      return {
        title: "Read session messages",
        output: JSON.stringify({ sessionId: session.id, status: st, messages: result, ...(truncated ? { truncated: true } : {}) }),
        metadata: { action: "messages", sessionId: session.id, count: result.length, ...(truncated ? { truncated: true } : {}) },
      }
    })

    const execute = Effect.fn("SessionTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      yield* validateActionParams(params)
      yield* ctx.metadata({ title: titleFor(params.action), metadata: { action: params.action, sessionId: params.sessionId } })

      switch (params.action) {
        case "list":
          return yield* list(params)
        case "get": {
          const id = SessionID.make(params.sessionId!)
          const sess = yield* sessions.get(id).pipe(
            Effect.catch((err: unknown) => {
              const m = err instanceof Error ? err.message : String(err)
              const tag = (err as any)?._tag
              if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
                return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
              }
              return Effect.fail(err as Error)
            }),
          )
          const st = yield* inDirectory(
            sess.directory,
            statuses.list().pipe(
              Effect.map((mp) => {
                const v = mp.get(id)
                return v ? (v.type as string) : "idle"
              }),
              Effect.catch(() => Effect.succeed("unknown")),
            ),
          ).pipe(Effect.orDie)
          const summary = projectSession(sess, st)
          return {
            title: "View session",
            output: JSON.stringify({ session: summary }),
            metadata: { action: "get", sessionId: summary.id } as Metadata,
          }
        }
        case "status":
          return yield* status(params)
        case "messages":
          return yield* messages(params, ctx)
        default:
          return yield* Effect.fail(new Error(`Unknown action: ${(params as any).action}`))
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        execute(params, ctx).pipe(Effect.orDie),
    }
  }),
)
