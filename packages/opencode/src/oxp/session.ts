import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Database } from "@opencode-ai/core/database/database"
import { SessionInspection } from "@opencode-ai/core/session/inspection"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { GoalAgent } from "@opencode-ai/core/goal/agent"
import { SessionTodo } from "@opencode-ai/schema/session-todo"
import { Parameters as CheckpointParameters } from "@/tool/checkpoint"
import { ExchangeError } from "@/exchange/error"
import { ExchangeSessionSearch } from "@/exchange/session-search"
import { OxpAuthority } from "./authority"
import { OxpError } from "./error"
import { OxpModelSelection } from "./model-selection"
import { OxpResult } from "./result"
import { OxpRoot } from "./root"
import { OxpSchema } from "./schema"
import { OxpSessionControl } from "./session-control"
import { OxpSupervision } from "./supervision"

const MAX_LIST = 100
const MAX_SCAN = 1_000
const SCAN_PAGE = 100
const MAX_DELETE_TREE = 10_000
const MAX_MESSAGES = 20
const MAX_MESSAGE_TEXT_BYTES = 4 * 1024
const MAX_PROMPT_TEXT_BYTES = 64 * 1024

const SessionIDInput = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
const PromptTextInput = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PROMPT_TEXT_BYTES),
)

export const ACTIONS = [
    "list",
    "search",
    "get",
    "messages",
    "children",
    "selection",
    "set_selection",
    "send",
    "turn",
    "background_subagents",
    "todo_get",
    "todo_set",
    "checkpoint",
    "goal",
    "pause",
    "resume",
    "abort",
    "archive",
    "unarchive",
    "delete",
] as const

export const DIRECT_ACTIONS = [
    "list",
    "search",
    "get",
    "messages",
    "children",
    "selection",
    "set_selection",
    "send",
    "turn",
    "background_subagents",
    "todo_get",
    "todo_set",
    "goal",
    "pause",
    "resume",
    "abort",
    "archive",
    "unarchive",
    "delete",
] as const

/**
 * Semantic targets owned by this executable supervision adapter. Keep these
 * derived from the action inventory: the global parity ledger may describe an
 * intended mapping, but only an action implemented here can make that mapping
 * executable.
 */
export function executableTargets(): ReadonlySet<string> {
  const actions = new Set<string>(DIRECT_ACTIONS)
  const targets = new Set<string>(["openfork_session"])
  if (actions.has("todo_get") && actions.has("todo_set")) targets.add("openfork_session.todo")
  if (actions.has("goal")) targets.add("openfork_session.goal")
  return targets
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(ACTIONS),
  sessionID: Schema.optional(SessionIDInput),
  rootID: Schema.optional(OxpSchema.RootID),
  parentID: Schema.optional(SessionIDInput),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIST }))),
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  tool: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  roots: Schema.optional(Schema.Boolean),
  includeArchived: Schema.optional(Schema.Boolean),
  beforeMessageID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  model: Schema.optional(OxpSchema.ModelSelection),
  text: Schema.optional(PromptTextInput),
  todos: Schema.optional(Schema.Array(SessionTodo.Info)),
  checkpoint: Schema.optional(CheckpointParameters),
  goal: Schema.optional(GoalAgent.Input),
})
export type Input = Schema.Schema.Type<typeof Parameters>

export const DirectParameters = Schema.Struct({
  action: Schema.Literals(DIRECT_ACTIONS),
  sessionID: Schema.optional(SessionIDInput),
  rootID: Schema.optional(OxpSchema.RootID),
  parentID: Schema.optional(SessionIDInput),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_LIST }))),
  search: Schema.optional(Schema.String.check(Schema.isMaxLength(4096))),
  roots: Schema.optional(Schema.Boolean),
  includeArchived: Schema.optional(Schema.Boolean),
  beforeMessageID: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))),
  model: Schema.optional(OxpSchema.ModelSelection),
  text: Schema.optional(PromptTextInput),
  todos: Schema.optional(Schema.Array(SessionTodo.Info)),
  goal: Schema.optional(GoalAgent.Input),
})

export const CheckpointCapabilityParameters = Schema.Struct({
  sessionID: SessionIDInput,
  rootID: Schema.optional(OxpSchema.RootID),
  checkpoint: CheckpointParameters,
})

export interface Interface {
  readonly execute: (input: Input, signal?: AbortSignal) => Effect.Effect<OxpResult.CapabilityResult, OxpError.Error>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/OxpSession") {}
export const use = serviceUse(Service)

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail<OxpError.Error>(new OxpError.Cancelled({ detail: "OXP Session request was cancelled" }))
    : Effect.void
}

function truncateUtf8(text: string, maxBytes: number) {
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maxBytes) return { text, truncated: false }
  return { text: bytes.subarray(0, maxBytes).toString("utf8"), truncated: true }
}

function parseSearchOperand(value?: string) {
  const search = value?.trim()
  if (!search) return { query: undefined, tool: undefined }
  const marker = /^tool:([^\s]+)(?:\s+([\s\S]*))?$/.exec(search)
  if (!marker) return { query: search, tool: undefined }
  const tool = marker[1]!
  if (tool.length > 128) {
    throw new OxpError.InvalidArgument({ detail: "session.search tool name exceeds 128 characters" })
  }
  const query = marker[2]?.trim()
  return { query: query || undefined, tool }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const authority = yield* OxpAuthority.Service
    const inspection = yield* SessionInspection.Service
    const control = yield* OxpSessionControl.Service
    const supervision = yield* OxpSupervision.Service
    const roots = yield* OxpRoot.Service
    const { readDb } = yield* Database.Service

    const requirePlane = Effect.fnUntraced(function* (operation: string) {
      const allowed = yield* authority.discover({ plane: "supervision", operation })
      if (!allowed) return yield* new OxpError.AuthDenied({ detail: "OXP Session supervision is not enabled" })
    })

    const project = (row: SessionInspection.SessionRow, admission: OxpAuthority.Admission) => {
      const root = admission.root
      if (!root || !("path" in root)) {
        throw new OxpError.NotFound({ detail: "Session is not available to OXP supervision" })
      }
      return {
        id: row.id,
        title: row.title,
        projectID: row.projectID,
        ...(row.workspaceID ? { workspaceID: row.workspaceID } : {}),
        ...(row.parentID ? { parentID: row.parentID } : {}),
        ...(row.agent ? { agent: row.agent } : {}),
        ...(row.model
          ? {
              model: OxpModelSelection.fromProviderModel(
                row.model.providerID,
                row.model.modelID,
                row.model.variant,
                row.model.accountID,
              ),
            }
          : {}),
        location: {
          rootID: root.root.id,
          path: root.virtualPath,
        },
        paused: row.pausedAt !== undefined,
        archived: row.archivedAt !== undefined,
        cost: row.cost,
        tokens: row.tokens,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }
    }

    const selection = (row: SessionInspection.SessionRow) => ({
      sessionID: row.id,
      ...(row.agent ? { agent: row.agent } : {}),
      ...(row.model
        ? {
            model: OxpModelSelection.fromProviderModel(
              row.model.providerID,
              row.model.modelID,
              row.model.variant,
              row.model.accountID,
            ),
          }
        : {}),
    })

    const mapControlError = (
      error: Error,
      explicitAccountID?: string,
    ): OxpError.Error => {
      if (OxpError.isError(error)) return error
      if (error instanceof OxpSessionControl.WaitCancelled) {
        return new OxpError.Cancelled({
          detail:
            "The supervised Session turn was admitted and continues, but the caller stopped waiting",
          metadata: {
            admittedMessageID: error.admittedMessageID,
            committed: true,
          },
        })
      }
      if (error instanceof OxpSessionControl.SelectionUnavailable) {
        if (error.kind === "provider-account") {
          return new OxpError.ProviderAccountUnavailable({
            detail: OxpError.boundDetail(error.message),
            ...(explicitAccountID
              ? { metadata: { accountID: explicitAccountID } }
              : {}),
          })
        }
        return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.message) })
      }
      if (error instanceof OxpSessionControl.GoalRevisionConflict) {
        return new OxpError.Conflict({
          detail: OxpError.boundDetail(error.message),
          metadata: {
            goalID: error.goalID.slice(0, 256),
            expectedRevision: error.expectedRevision,
            actualRevision: error.actualRevision,
          },
        })
      }
      if (error instanceof OxpSessionControl.GoalVerificationUnavailable) {
        return new OxpError.InvalidArgument({
          detail: OxpError.boundDetail(error.message),
          metadata: {
            goalID: error.goalID.slice(0, 256),
            status: error.status.slice(0, 256),
          },
        })
      }
      if (error instanceof OxpSessionControl.HostOwned) {
        const delegated = error.kind === "delegated_worker"
        return new OxpError.Conflict({
          detail: delegated
            ? "This Session is an OXP delegated worker; use openfork_worker continue with this Session ID instead of openfork_session send/turn"
            : `This Session is host-owned by ${error.kind}; use the producer-specific control surface instead of openfork_session send/turn`,
          metadata: {
            sessionID: error.sessionID.slice(0, 256),
            parentID: error.parentID.slice(0, 256),
            ownerKind: error.kind.slice(0, 128),
            ...(delegated ? { ownerSurface: "openfork_worker" } : {}),
          },
        })
      }
      const service = error.message.match(/Service not found:\s*([^\s)]+)/i)?.[1]
      if (service) {
        return new OxpError.DependencyUnavailable({
          detail: OxpError.boundDetail(
            `Native Session runtime dependency is unavailable: ${service}`,
          ),
          metadata: {
            dependency: service.slice(0, 256),
            nativeError: error.name.slice(0, 256),
          },
        })
      }
      if (/before initialization|uninitialized|initialization/i.test(error.message)) {
        return new OxpError.DependencyUnavailable({
          detail: "Native Session runtime initialization is incomplete; retrying the same operation is safe only if no mutation was reported committed",
          metadata: { nativeError: error.name.slice(0, 256) },
        })
      }
      return new OxpError.DependencyUnavailable({
        detail: "Native Session control failed",
        metadata: {
          nativeError: error.name.slice(0, 256),
        },
      })
    }

    const mapSearchError = (error: unknown): OxpError.Error => {
      if (OxpError.isError(error)) return error
      if (error instanceof ExchangeError.InvalidArgument) {
        return new OxpError.InvalidArgument({ detail: OxpError.boundDetail(error.detail) })
      }
      if (error instanceof ExchangeError.PathEscape) {
        return new OxpError.PathEscape({ detail: "Session search result escaped approved-root projection" })
      }
      if (error instanceof ExchangeError.Cancelled) {
        return new OxpError.Cancelled({ detail: "OXP Session search was cancelled" })
      }
      return new OxpError.DependencyUnavailable({
        detail: error instanceof ExchangeError.DependencyUnavailable
          ? OxpError.boundDetail(error.detail)
          : "OXP Session search failed",
      })
    }

    const projectSafe = Effect.fnUntraced(function* (
      row: SessionInspection.SessionRow,
      admission: OxpAuthority.Admission,
    ) {
      return yield* Effect.try({
        try: () => project(row, admission),
        catch: (cause) =>
          OxpError.isError(cause)
            ? cause
            : new OxpError.DependencyUnavailable({ detail: "Unable to project supervised Session state" }),
      })
    })

    const authorizeDeleteTree = Effect.fnUntraced(function* (
      root: SessionInspection.SessionRow,
      operation: string,
      rootID?: OxpSchema.RootID,
    ) {
      const admissions: OxpAuthority.Admission[] = []
      const queue: SessionSchema.ID[] = [root.id]
      const seen = new Set<string>(queue)

      for (let cursor = 0; cursor < queue.length; cursor++) {
        const parentID = queue[cursor]!
        let before: SessionInspection.ListInput["before"]

        while (true) {
          const page = yield* inspection.list({
            parentID,
            includeArchived: true,
            limit: SCAN_PAGE,
            ...(before ? { before } : {}),
          })
          if (page.length === 0) break

          for (const child of page) {
            if (seen.has(child.id)) continue
            if (seen.size >= MAX_DELETE_TREE) {
              return yield* new OxpError.InvalidArgument({
                detail: `Session delete tree exceeds the supervised safety limit of ${MAX_DELETE_TREE} Sessions`,
              })
            }

            const admission = yield* supervision.authorizeRow(child, operation, rootID).pipe(
              Effect.mapError((error): OxpError.Error =>
                error._tag === "OXP_DEPENDENCY_UNAVAILABLE"
                  ? error
                  : new OxpError.NotFound({
                      detail: "Session tree is not fully available to OXP supervision",
                    }),
              ),
            )
            seen.add(child.id)
            queue.push(child.id)
            admissions.push(admission)
          }

          if (page.length < SCAN_PAGE) break
          const tail = page.at(-1)
          if (!tail) break
          before = { updatedAt: tail.updatedAt, id: tail.id }
        }
      }

      return admissions
    })

    const authorizeSearchRoots = Effect.fnUntraced(function* (
      operation: string,
      rootID?: OxpSchema.RootID,
    ) {
      const rootIDs = rootID ? [rootID] : (yield* roots.list()).map((root) => root.id)
      const admitted = yield* Effect.forEach(rootIDs, (id) =>
        authority
          .authorize({
            plane: "supervision",
            operation,
            phase: "supervise",
            rootID: id,
          })
          .pipe(
            Effect.map((admission) => admission as OxpAuthority.Admission | undefined),
            Effect.catch((error) => {
              if (!rootID && (error._tag === "OXP_ROOT_CHANGED" || error._tag === "OXP_NOT_FOUND")) {
                return Effect.succeed(undefined)
              }
              return Effect.fail(error)
            }),
          ),
      )
      return admitted.filter((item): item is OxpAuthority.Admission => item !== undefined)
    })

    const executeRaw = Effect.fn("OxpSession.execute")(function* (input: Input, signal?: AbortSignal) {
      yield* cancelled(signal)
      const operation = "session." + input.action
      yield* requirePlane(operation)

      if (input.action === "list") {
        const requested = Math.min(input.limit ?? 50, MAX_LIST)
        const rows: Array<ReturnType<typeof project>> = []
        let before: SessionInspection.ListInput["before"]
        let scanned = 0
        let exhausted = false

        while (rows.length < requested && scanned < MAX_SCAN && !exhausted) {
          yield* cancelled(signal)
          const page = yield* inspection.list({
            limit: SCAN_PAGE,
            search: input.search,
            ...(input.parentID ? { parentID: SessionSchema.ID.make(input.parentID) } : {}),
            roots: input.roots,
            includeArchived: input.includeArchived,
            ...(before ? { before } : {}),
          })
          if (page.length === 0) break
          scanned += page.length
          exhausted = page.length < SCAN_PAGE
          const tail = page.at(-1)
          if (tail) before = { updatedAt: tail.updatedAt, id: tail.id }

          for (const row of page) {
            if (rows.length >= requested) break
            const admitted = yield* supervision.authorizeRow(row, operation, input.rootID).pipe(
              Effect.map((admission) => ({ ok: true as const, admission })),
              Effect.catch((error) =>
                error._tag === "OXP_DEPENDENCY_UNAVAILABLE"
                  ? Effect.fail(error)
                  : Effect.succeed({ ok: false as const }),
              ),
            )
            if (!admitted.ok) continue
            rows.push(yield* projectSafe(row, admitted.admission))
          }
        }

        const result = {
          sessions: rows,
          scanned,
          truncated: !exhausted && scanned >= MAX_SCAN,
        }
        return {
          title: "OpenFork Sessions",
          output: JSON.stringify(result),
          structured: result,
          metadata: { count: rows.length, scanned, truncated: result.truncated },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "search") {
        const parsed = yield* Effect.try({
          try: () => parseSearchOperand(input.search),
          catch: (cause) =>
            OxpError.isError(cause)
              ? cause
              : new OxpError.InvalidArgument({ detail: "session.search expression is invalid" }),
        })
        const query = parsed.query
        const tool = input.tool?.trim() || parsed.tool
        if (!query && !tool) {
          return yield* new OxpError.InvalidArgument({
            detail: "session.search requires query or tool",
          })
        }

        const admissions = yield* authorizeSearchRoots(operation, input.rootID)
        yield* cancelled(signal)
        const admittedRoots = admissions
          .flatMap((admission) => admission.root ? [admission.root] : [])
          .sort((a, b) => b.canonicalPath.length - a.canonicalPath.length)

        const result = yield* ExchangeSessionSearch.execute(
          readDb,
          {
            ...(query ? { query } : {}),
            ...(tool ? { tool } : {}),
            directoryPrefixes: admittedRoots.map((entry) => entry.canonicalPath),
            ...(input.parentID ? { parentID: SessionSchema.ID.make(input.parentID) } : {}),
            ...(input.roots !== undefined ? { roots: input.roots } : {}),
            includeArchived: input.includeArchived === true,
            limit: Math.min(input.limit ?? 20, MAX_LIST),
            scopeLabel: input.rootID ? "root:" + input.rootID : "approved-roots",
          },
          {
            revalidate: () =>
              Effect.gen(function* () {
                yield* cancelled(signal)
                for (const admission of admissions) {
                  yield* authority.revalidate(admission, "supervise")
                }
              }),
            projectDirectory: (directory) => {
              const entry = admittedRoots.find((root) => OxpRoot.isContained(root.canonicalPath, directory))
              if (!entry) throw new Error("Session search result is outside every admitted OXP root")
              return roots.toVirtualPath(entry.root, directory)
            },
          },
        ).pipe(Effect.mapError(mapSearchError))

        return {
          title: result.title,
          output: result.output,
          structured: result.structured,
          metadata: {
            ...result.metadata,
            authorizedRoots: admissions.length,
          },
          mutation: result.mutation,
        } satisfies OxpResult.CapabilityResult
      }

      const sessionID = input.action === "children" ? input.sessionID ?? input.parentID : input.sessionID
      if (!sessionID) {
        return yield* new OxpError.InvalidArgument({ detail: "session." + input.action + " requires sessionID" })
      }
      const nativeID = SessionSchema.ID.make(sessionID)
      const target = yield* supervision.resolve(sessionID, operation, input.rootID)

      if (input.action === "get") {
        const session = yield* projectSafe(target.row, target.admission)
        return {
          title: "OpenFork Session",
          output: JSON.stringify(session),
          structured: session,
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "selection") {
        const result = selection(target.row)
        return {
          title: "OpenFork Session selection",
          output: JSON.stringify(result),
          structured: result,
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "messages") {
        const page = yield* inspection.messages({
          sessionID: nativeID,
          limit: Math.min(input.limit ?? 20, MAX_MESSAGES),
          beforeMessageID: input.beforeMessageID,
        })
        const messages = page.items.map((message) => {
          const compact = truncateUtf8(message.text, MAX_MESSAGE_TEXT_BYTES)
          return {
            ...message,
            text: compact.text,
            truncated: message.truncated || compact.truncated,
          }
        })
        const result = {
          sessionID,
          messages,
          more: page.more,
          ...(page.beforeMessageID ? { beforeMessageID: page.beforeMessageID } : {}),
        }
        return {
          title: "OpenFork Session messages",
          output: JSON.stringify(result),
          structured: result,
          metadata: { count: messages.length, more: page.more },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "children") {
        const children = yield* inspection.children(nativeID, Math.min(input.limit ?? 50, MAX_LIST))
        const visible = []
        for (const child of children) {
          const admitted = yield* supervision.authorizeRow(child, operation, input.rootID).pipe(
            Effect.map((admission) => ({ ok: true as const, admission })),
            Effect.catch((error) =>
              error._tag === "OXP_DEPENDENCY_UNAVAILABLE"
                ? Effect.fail(error)
                : Effect.succeed({ ok: false as const }),
            ),
          )
          if (!admitted.ok) continue
          visible.push(yield* projectSafe(child, admitted.admission))
        }
        const result = { parentID: sessionID, sessions: visible }
        return {
          title: "OpenFork child Sessions",
          output: JSON.stringify(result),
          structured: result,
          metadata: { count: visible.length },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "todo_get") {
        const admitted = yield* authority.revalidate(target.admission, "supervise")
        const todos = yield* control
          .todoGet(supervision.runtimeTarget({ row: target.row, admission: admitted }, "supervise"))
          .pipe(Effect.mapError((error) => mapControlError(error)))
        const result = { sessionID, todos }
        return {
          title: "OpenFork Session todos",
          output: JSON.stringify(result),
          structured: result,
          metadata: { count: todos.length },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "todo_set") {
        if (!input.todos) {
          return yield* new OxpError.InvalidArgument({ detail: "session.todo_set requires todos" })
        }
        const admitted = yield* authority.revalidate(target.admission, "control")
        const todos = yield* control
          .todoSet(supervision.runtimeTarget({ row: target.row, admission: admitted }, "commit"), input.todos)
          .pipe(Effect.mapError((error) => mapControlError(error)))
        const result = { sessionID, todos }
        return {
          title: "OpenFork Session todos updated",
          output: JSON.stringify(result),
          structured: result,
          metadata: { count: todos.length },
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "checkpoint") {
        if (!input.checkpoint) {
          return yield* new OxpError.InvalidArgument({ detail: "session.checkpoint requires checkpoint" })
        }
        let admitted = yield* authority.revalidate(target.admission, "supervise")
        let runtimeTarget = supervision.runtimeTarget({ row: target.row, admission: admitted }, "supervise")
        const mode = input.checkpoint.mode ?? "list"
        const mutating = mode === "restore" && input.checkpoint.dryRun === false
        if (mutating) {
          const write = yield* authority.authorize({
            plane: "augmentation",
            operation: "write",
            phase: "mutate",
            rootID: input.rootID,
            path: target.row.directory,
          })
          const superviseCommit = supervision.runtimeTarget({ row: target.row, admission: admitted }, "commit").commitGuard
          runtimeTarget = {
            ...runtimeTarget,
            commitGuard: async () => {
              if (superviseCommit) await superviseCommit()
              await Effect.runPromise(authority.revalidate(write, "commit").pipe(Effect.asVoid))
            },
          }
        }
        const result = yield* control.checkpoint(runtimeTarget, input.checkpoint).pipe(
          Effect.mapError((error) => mapControlError(error)),
        )
        return {
          title: result.title,
          output: result.output,
          structured: { sessionID, mode, metadata: result.metadata },
          metadata: { ...result.metadata, sessionID },
          ...(mutating ? { mutation: { attempted: true, committed: true } } : {}),
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "goal") {
        if (!input.goal) {
          return yield* new OxpError.InvalidArgument({ detail: "session.goal requires goal" })
        }
        const admitted = yield* authority.revalidate(target.admission, input.goal.action === "status" ? "supervise" : "control")
        const result = yield* control
          .goal(
            supervision.runtimeTarget(
              { row: target.row, admission: admitted },
              input.goal.action === "status" ? "supervise" : "commit",
            ),
            input.goal,
          )
          .pipe(Effect.mapError((error) => mapControlError(error)))
        const structured = {
          sessionID,
          ...result,
          ...(input.goal.action === "request_verification"
            ? { verificationDispatch: "scheduled" as const }
            : {}),
        }
        return {
          title: "OpenFork Session Goal " + input.goal.action,
          output: JSON.stringify(structured),
          structured,
          ...(input.goal.action === "status" ? {} : { mutation: { attempted: true, committed: true } }),
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "set_selection") {
        if (!input.model) {
          return yield* new OxpError.InvalidArgument({
            detail: "session.set_selection requires model",
          })
        }
        const normalized = yield* Effect.try({
          try: () => OxpModelSelection.normalize(input.model!),
          catch: (cause) =>
            OxpError.isError(cause)
              ? cause
              : new OxpError.InvalidArgument({
                  detail: "Invalid Session model selection",
                }),
        })
        const admitted = yield* authority.revalidate(target.admission, "control")
        yield* control
          .setSelection(supervision.runtimeTarget({ row: target.row, admission: admitted }), {
            model: normalized,
            actorRef: supervision.actorRef(admitted),
          })
          .pipe(
            Effect.mapError((error) =>
              mapControlError(error, normalized.accountID),
            ),
          )
        const updated = yield* inspection.get(nativeID)
        if (!updated) {
          return yield* new OxpError.NotFound({
            detail: "Session is not available to OXP supervision",
          })
        }
        const result = selection(updated)
        return {
          title: "OpenFork Session selection updated",
          output: JSON.stringify(result),
          structured: result,
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "send" || input.action === "turn") {
        if (!input.text || input.text.trim().length === 0) {
          return yield* new OxpError.InvalidArgument({
            detail: "session." + input.action + " requires non-empty text",
          })
        }
        const admitted = yield* authority.revalidate(target.admission, "control")
        const promptInput: OxpSessionControl.PromptInput = {
          text: input.text,
          actorRef: supervision.actorRef(admitted),
        }
        const result = yield* (
          input.action === "send"
            ? control.send(supervision.runtimeTarget({ row: target.row, admission: admitted }), promptInput)
            : control.turn(
                supervision.runtimeTarget({ row: target.row, admission: admitted }),
                promptInput,
                signal,
              )
        ).pipe(Effect.mapError((error) => mapControlError(error)))
        const structured = {
          sessionID,
          action: input.action,
          admittedMessageID: result.admittedMessageID,
          paused: result.paused,
          ...(result.resultMessageID
            ? { resultMessageID: result.resultMessageID }
            : {}),
        }
        return {
          title: "OpenFork Session " + input.action,
          output: JSON.stringify(structured),
          structured,
          mutation: { attempted: true, committed: true },
        } satisfies OxpResult.CapabilityResult
      }

      if (input.action === "background_subagents") {
        const admitted = yield* authority.revalidate(target.admission, "control")
        const result = yield* control
          .backgroundSubagents(supervision.runtimeTarget({ row: target.row, admission: admitted }))
          .pipe(Effect.mapError((error) => mapControlError(error)))
        const structured = {
          sessionID,
          promoted: result.promoted,
        }
        return {
          title: "OpenFork Session background subagents",
          output: JSON.stringify(structured),
          structured,
          mutation: {
            attempted: true,
            committed: result.promoted > 0,
          },
        } satisfies OxpResult.CapabilityResult
      }

      yield* cancelled(signal)
      if (input.action === "delete") {
        // Preflight the complete native recursive delete scope before entering
        // runtime control. The commit guard below repeats this walk after the
        // active prompt has been quiesced to narrow the mutation race window.
        yield* authorizeDeleteTree(target.row, operation, input.rootID)
      }
      const controlAdmission = yield* authority.revalidate(
        target.admission,
        "control",
      )
      const baseTargetRuntime = supervision.runtimeTarget({ row: target.row, admission: controlAdmission })
      const targetRuntime =
        input.action === "delete"
          ? {
              ...baseTargetRuntime,
              commitGuard: async () => {
                if (baseTargetRuntime.commitGuard) await baseTargetRuntime.commitGuard()
                const descendants = await Effect.runPromise(
                  authorizeDeleteTree(target.row, operation, input.rootID),
                )
                for (const admission of descendants) {
                  await Effect.runPromise(authority.revalidate(admission, "commit").pipe(Effect.asVoid))
                }
              },
            }
          : baseTargetRuntime
      const controlEffect =
        input.action === "pause"
          ? control.pause(targetRuntime)
          : input.action === "resume"
            ? control.resume(targetRuntime)
            : input.action === "abort"
              ? control.abort(targetRuntime)
              : input.action === "archive"
                ? control.archive(targetRuntime)
                : input.action === "unarchive"
                  ? control.unarchive(targetRuntime)
                  : control.delete(targetRuntime)
      yield* controlEffect.pipe(
        Effect.mapError((error) => mapControlError(error)),
      )

      const updated = yield* inspection.get(nativeID)
      const projected = updated
        ? yield* projectSafe(updated, yield* authority.revalidate(target.admission, "supervise"))
        : undefined
      return {
        title: "OpenFork Session " + input.action,
        output: JSON.stringify({ sessionID, action: input.action, ...(projected ? { session: projected } : {}) }),
        structured: { sessionID, action: input.action, ...(projected ? { session: projected } : {}) },
        mutation: { attempted: true, committed: true },
      } satisfies OxpResult.CapabilityResult
    })

    const execute: Interface["execute"] = (input, signal) =>
      executeRaw(input, signal).pipe(
        Effect.catch((error) =>
          OxpError.isError(error)
            ? Effect.fail(error)
            : Effect.fail(new OxpError.DependencyUnavailable({ detail: "OXP Session operation failed" })),
        ),
      )

    return Service.of({ execute })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [OxpAuthority.node, SessionInspection.node, OxpSessionControl.node, OxpSupervision.node, OxpRoot.node, Database.node],
})

export * as OxpSession from "./session"
