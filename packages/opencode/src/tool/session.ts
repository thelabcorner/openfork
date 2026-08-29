import { Effect, Schema, Option, Scope, Fiber, Cause } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./session.txt"
import { Session } from "@/session/session"
import { SessionStatus } from "@/session/status"
import { InstanceState } from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Project } from "@/project/project"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { SessionID, MessageID } from "@/session/schema"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import type { TaskPromptOps } from "./task"

export const Parameters = Schema.Struct({
  action: Schema.Literals(["list", "get", "status", "messages", "create", "send", "fork"]).annotate({
    description: "Action to perform",
  }),
  sessionId: Schema.optional(Schema.String).annotate({ description: "Target session ID for get/status/messages/send/fork" }),
  scope: Schema.optional(Schema.Literals(["current", "project", "global"])).annotate({
    description: "list: current (default), project, or global",
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "Max items to return (default 10, max 100)",
  }),
  search: Schema.optional(Schema.String).annotate({ description: "list: title search substring" }),
  roots: Schema.optional(Schema.Boolean).annotate({ description: "list: only root sessions (parentID null)" }),
  includeArchived: Schema.optional(Schema.Boolean).annotate({ description: "list: include archived sessions" }),
  withStatus: Schema.optional(Schema.Boolean).annotate({ description: "list: attach live status per session" }),
  role: Schema.optional(Schema.Literals(["all", "user", "assistant"])).annotate({
    description: "messages: filter by role (default all)",
  }),
  last: Schema.optional(Schema.Boolean).annotate({ description: "messages: return only the last matching message" }),
  includeSynthetic: Schema.optional(Schema.Boolean).annotate({ description: "messages: include synthetic text parts" }),
  title: Schema.optional(Schema.String).annotate({ description: "create: optional title" }),
  prompt: Schema.optional(Schema.String).annotate({ description: "create/send/fork: prompt text to send" }),
  messageId: Schema.optional(Schema.String).annotate({ description: "fork: message ID boundary" }),
  model: Schema.optional(Schema.String).annotate({ description: "create/send/fork: provider/model override (provider/model)" }),
  agent: Schema.optional(Schema.String).annotate({ description: "create/send/fork: agent override" }),
  variant: Schema.optional(Schema.String).annotate({ description: "create/send/fork: model variant override" }),
  wait: Schema.optional(Schema.Boolean).annotate({ description: "create/send/fork/messages: wait for completion" }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "wait timeout in seconds (default 600, max 86400)",
  }),
  lastAssistant: Schema.optional(Schema.Boolean).annotate({ description: "create/send/fork with wait: include last assistant text" }),
})

type Metadata = {
  action: string
  count?: number
  scope?: string
  sessionId?: string
  paused?: boolean
  wait?: boolean
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
  createdAt: number
  completedAt?: number
  agent?: string
  model?: string
  variant?: string
  synthetic?: boolean
  text: string
}

function extractAgentMessage(message: SessionV1.WithParts, includeSynthetic: boolean): AgentSessionMessage | undefined {
  const info = message.info as any
  if (info.role !== "user" && info.role !== "assistant") return undefined
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
    case "create":
      return "Create session"
    case "send":
      return "Send session prompt"
    case "fork":
      return "Fork session"
    default:
      return "Session"
  }
}

const validateActionParams = Effect.fn("SessionTool.validateActionParams")(function* (
  params: Schema.Schema.Type<typeof Parameters>,
) {
  const action = params.action
  if (action === "get" || action === "status" || action === "messages" || action === "send" || action === "fork") {
    if (!params.sessionId) return yield* Effect.fail(new Error(`sessionId is required for ${action}`))
  }
  if (action === "send") {
    if (!params.prompt || params.prompt.trim() === "") return yield* Effect.fail(new Error("prompt is required for send"))
  }
  if (params.messageId && action !== "fork") {
    return yield* Effect.fail(new Error("messageId is only valid for fork"))
  }
  if (params.last === true && params.limit !== undefined) {
    return yield* Effect.fail(new Error("last cannot be combined with limit"))
  }
  if (params.lastAssistant === true && params.wait !== true) {
    return yield* Effect.fail(new Error("lastAssistant requires wait"))
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
  if (params.role !== undefined && action !== "messages") {
    return yield* Effect.fail(new Error("role is only valid for messages"))
  }
  if (params.includeSynthetic !== undefined && action !== "messages") {
    return yield* Effect.fail(new Error("includeSynthetic is only valid for messages"))
  }
  if (params.title !== undefined && action !== "create") {
    return yield* Effect.fail(new Error("title is only valid for create"))
  }
  if (params.wait === true) {
    const t = normalizeTimeout(params.timeout)
    if (t > 86400) return yield* Effect.fail(new Error("timeout must be <= 86400"))
  }
  if (action === "create" && params.sessionId) {
    return yield* Effect.fail(new Error("sessionId is not valid for create"))
  }
  if ((action === "list" || action === "get") && params.prompt) {
    return yield* Effect.fail(new Error("prompt is not valid for list/get"))
  }
})

export const SessionTool = Tool.define<typeof Parameters, Metadata, Session.Service | SessionStatus.Service | Project.Service | Agent.Service | Provider.Service>(
  "session",
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const statuses = yield* SessionStatus.Service
    const projects = yield* Project.Service
    const agents = yield* Agent.Service
    const providers = yield* Provider.Service

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

    const resolveExistingSelection = Effect.fn("SessionTool.resolveExistingSelection")(function* (session: Session.Info) {
      let agentName = session.agent
      let model: { providerID: ProviderV2.ID; modelID: ModelV2.ID; variant?: string } | undefined = session.model
        ? {
            providerID: session.model.providerID,
            modelID: session.model.id,
            variant: session.model.variant === "default" ? undefined : session.model.variant,
          }
        : undefined
      if (agentName && model) return { agent: agentName, model }
      const history = yield* sessions.messages({ sessionID: session.id as SessionID, limit: 20 }).pipe(Effect.orDie)
      for (let i = history.length - 1; i >= 0; i--) {
        const msg = history[i]
        if (!msg) continue
        if (msg.info.role !== "user") continue
        const info: any = msg.info
        if (!agentName && info.agent) agentName = info.agent
        if (!model && info.model) {
          model = {
            providerID: info.model.providerID,
            modelID: info.model.modelID,
            variant: info.model.variant,
          }
        }
        if (agentName && model) break
      }
      return { agent: agentName, model }
    })

    const validateSelection = Effect.fn("SessionTool.validateSelection")(function* (input: {
      agent?: string
      model?: string
      variant?: string
      directory: string
    }) {
      if (input.agent) {
        const found = yield* inDirectory(input.directory, agents.get(input.agent)).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
          Effect.orDie,
        )
        if (!found) {
          const all = yield* inDirectory(input.directory, agents.list()).pipe(Effect.orDie)
          const primary = all
            .filter((a) => a.mode !== "subagent")
            .map((a) => a.name)
            .slice(0, 8)
            .join(", ")
          const hint = primary ? ` Available primary agents: ${primary}` : ""
          return yield* Effect.fail(new Error(`Unknown agent "${input.agent}".${hint}`))
        }
      }
      let resolvedModel: Provider.Model | undefined
      if (input.model) {
        const parsed = Provider.parseModel(input.model)
        const mdl = yield* inDirectory(
          input.directory,
          providers.getModel(parsed.providerID, parsed.modelID).pipe(
            Effect.catchTag("ProviderModelNotFoundError", (err: any) => {
              const hint = err.suggestions?.length ? ` Did you mean: ${err.suggestions.join(", ")}?` : ""
              return Effect.fail(new Error(`Unknown model "${input.model}" for ${input.directory}.${hint}`))
            }),
          ),
        ).pipe(Effect.orDie)
        resolvedModel = mdl as unknown as Provider.Model
      }
      if (input.variant) {
        let effectiveModel = resolvedModel
        if (!effectiveModel && input.model) {
          const parsed = Provider.parseModel(input.model)
          const opt = yield* inDirectory(input.directory, providers.getModel(parsed.providerID, parsed.modelID).pipe(Effect.option)).pipe(
            Effect.orDie,
          )
          if (Option.isSome(opt)) effectiveModel = opt.value as unknown as Provider.Model
        }
        if (!effectiveModel && !input.model) {
          return yield* Effect.fail(new Error(`variant "${input.variant}" requires a model to validate against`))
        }
        if (effectiveModel && input.variant) {
          const variants = (effectiveModel as any).variants ?? {}
          if (variants && Object.keys(variants).length > 0 && !variants[input.variant]) {
            const modelName = input.model ?? `${(effectiveModel as any).providerID}/${(effectiveModel as any).id}`
            return yield* Effect.fail(new Error(`Unknown variant "${input.variant}" for model "${modelName}"`))
          }
        }
      }
      return resolvedModel
    })

    const list = Effect.fn("SessionTool.list")(function* (params: Schema.Schema.Type<typeof Parameters>) {
      const current = yield* InstanceState.context
      const scopeVal = params.scope ?? "current"
      const limit = normalizeLimit(params.limit, 10)
      let rows: Session.Info[] = []
      if (scopeVal === "global") {
        const globalRows = yield* sessions
          .listGlobal({
            limit,
            search: params.search?.trim() || undefined,
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
            return m.role === role
          })

      let raw = yield* sessions.messages({ sessionID: id, limit: fetchLimit }).pipe(Effect.orDie)
      let filtered = toAgent(raw)
      if (filtered.length < limit && raw.length >= fetchLimit) {
        raw = yield* sessions.messages({ sessionID: id }).pipe(Effect.orDie)
        filtered = toAgent(raw)
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
        output: JSON.stringify({ sessionId: session.id, status: st, messages: result }),
        metadata: { action: "messages", sessionId: session.id, count: result.length },
      }
    })

    const doCreate = Effect.fn("SessionTool.create")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const current = yield* InstanceState.context
      if (params.model || params.agent || params.variant) {
        yield* validateSelection({
          agent: params.agent,
          model: params.model,
          variant: params.variant,
          directory: current.directory,
        })
      }
      if (params.wait === true && params.prompt === undefined) {
        return yield* Effect.fail(new Error("wait requires prompt"))
      }
      const modelRef = params.model
        ? (() => {
            const p = Provider.parseModel(params.model!)
            return { id: p.modelID, providerID: p.providerID, variant: params.variant ?? "default" }
          })()
        : undefined

      const created = yield* sessions
        .create({
          title: params.title,
          agent: params.agent,
          model: modelRef,
        })
        .pipe(Effect.orDie)

      if (!params.prompt) {
        return {
          title: "Create session",
          output: JSON.stringify({
            sessionId: created.id,
            directory: created.directory,
            created: true,
            title: created.title,
          }),
          metadata: { action: "create", sessionId: created.id },
        }
      }

      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops?.dispatch) return yield* Effect.fail(new Error("Session tool requires promptOps in tool execution context"))

      const parts = yield* ops.resolvePromptParts(params.prompt!).pipe(Effect.orDie)

      const dispatchInput: any = {
        sessionID: created.id,
        agent: params.agent,
        model: modelRef ? { providerID: modelRef.providerID, modelID: modelRef.id } : undefined,
        variant: params.variant,
        parts,
      }

      const result = yield* ops.dispatch!(dispatchInput, { wait: params.wait === true }).pipe(Effect.orDie)

      if (params.wait === true) {
        const payload: any = {
          sessionId: created.id,
          directory: created.directory,
          created: true,
          promptAdmitted: true,
          runStarted: !result.paused,
          paused: result.paused,
          waited: true,
        }
        if (params.lastAssistant && result.result) {
          const am = extractAgentMessage(result.result, false)
          if (am) payload.lastAssistant = { id: am.id, text: am.text }
          else {
            const msgs = yield* sessions.messages({ sessionID: created.id as SessionID }).pipe(Effect.orDie)
            const last = msgs.filter((m) => m.info.role === "assistant").at(-1)
            if (last) {
              const am2 = extractAgentMessage(last, false)
              if (am2) payload.lastAssistant = { id: am2.id, text: am2.text }
            }
          }
        } else if (params.lastAssistant) {
          const msgs = yield* sessions.messages({ sessionID: created.id as SessionID }).pipe(Effect.orDie)
          const last = msgs.filter((m) => m.info.role === "assistant").at(-1)
          if (last) {
            const am2 = extractAgentMessage(last, false)
            if (am2) payload.lastAssistant = { id: am2.id, text: am2.text }
          }
        }
        return {
          title: "Create session",
          output: JSON.stringify(payload),
          metadata: { action: "create", sessionId: created.id, wait: true, paused: result.paused },
        }
      }

      return {
        title: "Create session",
        output: JSON.stringify({
          sessionId: created.id,
          directory: created.directory,
          created: true,
          promptAdmitted: true,
          runStarted: !result.paused,
          paused: result.paused,
          waited: false,
        }),
        metadata: { action: "create", sessionId: created.id, paused: result.paused },
      }
    })

    const doSend = Effect.fn("SessionTool.send")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const id = SessionID.make(params.sessionId!)
      const target = yield* sessions.get(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )
      const promptText = params.prompt!
      return yield* inDirectory(
        target.directory,
        Effect.gen(function* () {
          const existing = yield* resolveExistingSelection(target)
          const effectiveAgent = params.agent ?? existing.agent
          const parsedModel = params.model ? Provider.parseModel(params.model) : undefined
          const effectiveModel = parsedModel
            ? { providerID: parsedModel.providerID, modelID: parsedModel.modelID, variant: params.variant }
            : existing.model
              ? {
                  providerID: existing.model.providerID,
                  modelID: existing.model.modelID,
                  variant: params.variant ?? existing.model.variant,
                }
              : undefined
          if (params.agent || params.model || params.variant) {
            yield* validateSelection({
              agent: params.agent,
              model: params.model,
              variant: params.variant,
              directory: target.directory,
            })
            if (params.variant && !params.model && effectiveModel) {
              yield* validateSelection({
                agent: undefined,
                model: `${effectiveModel.providerID}/${effectiveModel.modelID}`,
                variant: params.variant,
                directory: target.directory,
              })
            }
          }

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops?.dispatch) return yield* Effect.fail(new Error("Session tool requires promptOps in tool execution context"))
          const parts = yield* ops.resolvePromptParts(promptText).pipe(Effect.orDie)

          const modelRef = effectiveModel ? { providerID: effectiveModel.providerID, modelID: effectiveModel.modelID } : undefined
          const variant = effectiveModel?.variant

          const dispatchInput: any = {
            sessionID: target.id,
            agent: effectiveAgent,
            model: modelRef,
            variant,
            parts,
          }

          const result = yield* ops.dispatch!(dispatchInput, { wait: params.wait === true }).pipe(Effect.orDie)

          if (params.wait === true) {
            const payload: any = {
              sessionId: target.id,
              directory: target.directory,
              promptAdmitted: true,
              runStarted: !result.paused,
              paused: result.paused,
              waited: true,
            }
            if (params.lastAssistant) {
              let am: AgentSessionMessage | undefined
              if (result.result) am = extractAgentMessage(result.result, false)
              if (!am) {
                const msgs = yield* sessions.messages({ sessionID: id }).pipe(Effect.orDie)
                const last = msgs.filter((m) => m.info.role === "assistant").at(-1)
                if (last) am = extractAgentMessage(last, false)
              }
              if (am) payload.lastAssistant = { id: am.id, text: am.text }
            }
            return {
              title: "Send session prompt",
              output: JSON.stringify(payload),
              metadata: { action: "send", sessionId: target.id, wait: true, paused: result.paused } as Metadata,
            }
          }

          return {
            title: "Send session prompt",
            output: JSON.stringify({
              sessionId: target.id,
              directory: target.directory,
              promptAdmitted: true,
              runStarted: !result.paused,
              paused: result.paused,
              waited: false,
            }),
            metadata: { action: "send", sessionId: target.id, paused: result.paused } as Metadata,
          }
        }),
      )
    })

    const doFork = Effect.fn("SessionTool.fork")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const id = SessionID.make(params.sessionId!)
      const source = yield* sessions.get(id).pipe(
        Effect.catch((err: unknown) => {
          const m = err instanceof Error ? err.message : String(err)
          const tag = (err as any)?._tag
          if (tag === "NotFoundError" || m.toLowerCase().includes("not found")) {
            return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
          }
          return Effect.fail(err as Error)
        }),
      )

      return yield* inDirectory(
        source.directory,
        Effect.gen(function* () {
          if (params.model || params.agent || params.variant) {
            yield* validateSelection({
              agent: params.agent,
              model: params.model,
              variant: params.variant,
              directory: source.directory,
            })
          }

          const existing = yield* resolveExistingSelection(source)

          const effectiveAgent = params.agent ?? existing.agent
          const parsedModel = params.model ? Provider.parseModel(params.model) : undefined
          const effectiveModel = parsedModel
            ? { providerID: parsedModel.providerID, modelID: parsedModel.modelID, variant: params.variant }
            : existing.model
              ? {
                  providerID: existing.model.providerID,
                  modelID: existing.model.modelID,
                  variant: params.variant ?? existing.model.variant,
                }
              : undefined

          const messageID = params.messageId ? MessageID.make(params.messageId) : undefined

          const forked = yield* sessions
            .fork({ sessionID: source.id as SessionID, messageID })
            .pipe(
              Effect.catch((err: unknown) => {
                const m = err instanceof Error ? err.message : String(err)
                const tag = (err as any)?._tag
                if (tag === "NotFoundError" || m.toLowerCase().includes("not found") || m.includes("Message not found")) {
                  if (params.messageId) return Effect.fail(new Error(`Message not found: ${params.messageId}`))
                  return Effect.fail(new Error(`Session not found: ${params.sessionId}`))
                }
                return Effect.fail(err as Error)
              }),
              Effect.orDie,
            )

          const typedForked = forked as Session.Info

          if (effectiveAgent || effectiveModel) {
            const modelForFork = effectiveModel
              ? { id: effectiveModel.modelID, providerID: effectiveModel.providerID, variant: effectiveModel.variant ?? "default" }
              : undefined
            if (modelForFork && effectiveAgent) {
              yield* sessions
                .setAgentModel({
                  sessionID: typedForked.id as SessionID,
                  agent: effectiveAgent,
                  model: modelForFork,
                  time: Date.now(),
                })
                .pipe(Effect.catch(() => Effect.void), Effect.orDie)
            } else if (effectiveAgent && !modelForFork && existing.model) {
              const m = existing.model
              yield* sessions
                .setAgentModel({
                  sessionID: typedForked.id as SessionID,
                  agent: effectiveAgent,
                  model: { id: m.modelID, providerID: m.providerID, variant: m.variant ?? "default" },
                  time: Date.now(),
                })
                .pipe(Effect.catch(() => Effect.void), Effect.orDie)
            }
          }

          if (!params.prompt) {
            return {
              title: "Fork session",
              output: JSON.stringify({
                sessionId: typedForked.id,
                directory: typedForked.directory,
                forkedFrom: source.id,
                created: true,
              }),
              metadata: { action: "fork", sessionId: typedForked.id } as Metadata,
            }
          }

          const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
          if (!ops?.dispatch) return yield* Effect.fail(new Error("Session tool requires promptOps in tool execution context"))
          const parts = yield* ops.resolvePromptParts(params.prompt!).pipe(Effect.orDie)

          const dispatchInput: any = {
            sessionID: typedForked.id,
            agent: effectiveAgent,
            model: effectiveModel ? { providerID: effectiveModel.providerID, modelID: effectiveModel.modelID } : undefined,
            variant: effectiveModel?.variant,
            parts,
          }

          const result = yield* ops.dispatch!(dispatchInput, { wait: params.wait === true }).pipe(Effect.orDie)

          if (params.wait === true) {
            const payload: any = {
              sessionId: typedForked.id,
              directory: typedForked.directory,
              forkedFrom: source.id,
              created: true,
              promptAdmitted: true,
              runStarted: !result.paused,
              paused: result.paused,
              waited: true,
            }
            if (params.lastAssistant && result.result) {
              const am = extractAgentMessage(result.result, false)
              if (am) payload.lastAssistant = { id: am.id, text: am.text }
            } else if (params.lastAssistant) {
              const msgs = yield* sessions.messages({ sessionID: typedForked.id as SessionID }).pipe(Effect.orDie)
              const last = msgs.filter((m) => m.info.role === "assistant").at(-1)
              if (last) {
                const am = extractAgentMessage(last, false)
                if (am) payload.lastAssistant = { id: am.id, text: am.text }
              }
            }
            return {
              title: "Fork session",
              output: JSON.stringify(payload),
              metadata: { action: "fork", sessionId: typedForked.id, wait: true, paused: result.paused } as Metadata,
            }
          }

          return {
            title: "Fork session",
            output: JSON.stringify({
              sessionId: typedForked.id,
              directory: typedForked.directory,
              forkedFrom: source.id,
              created: true,
              promptAdmitted: true,
              runStarted: !result.paused,
              paused: result.paused,
              waited: false,
            }),
            metadata: { action: "fork", sessionId: typedForked.id, paused: result.paused } as Metadata,
          }
        }),
      )
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
        case "create":
          return yield* doCreate(params, ctx)
        case "send":
          return yield* doSend(params, ctx)
        case "fork":
          return yield* doFork(params, ctx)
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
