import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { Database } from "@opencode-ai/core/database/database"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import type { ProviderRouteIntent } from "@opencode-ai/schema/model-select/provider-route-intent"
import { Effect, Exit, Option, Scope } from "effect"
import { BackgroundJob } from "@/background/job"
import { Config } from "@/config/config"
import { EffectBridge } from "@/effect/bridge"
import { Agent } from "@/agent/agent"
import { deriveSubagentSessionPermission } from "@/agent/subagent-permissions"
import { Session } from "./session"
import { MessageV2 } from "./message-v2"
import { MessageID, SessionID } from "./schema"
import type { SessionPromptOps } from "./prompt-contract"
import { DelegatedWorkerPolicy } from "./delegated-worker-policy"
import { SupervisorRegistryTag } from "./subagent-supervision-contract"
import * as SubagentSupervisionMetadata from "./subagent-supervision-metadata"

export const ID = "task"

/**
 * Explicit Task execution mode. Kept alongside the legacy `background` alias for
 * compatibility. Supervisor maps onto detached execution while retaining parent
 * responsibility.
 */
export type TaskMode = "foreground" | "background" | "supervisor"

export const BACKGROUND_DESCRIPTION = [
  "Execution mode is chosen with `mode` (foreground | background | supervisor); the legacy `background` boolean remains a compatibility alias and must not be combined with `mode`.",
  "foreground (default) blocks until the child finishes. background detaches and returns immediately. supervisor detaches but keeps you responsible for the worker.",
  "Foreground and background use the same child session, history, tools, and permissions; only parent waiting behavior changes.",
  "A running background task can be foregrounded by calling task again with its task_id and no prompt.",
  "A running task can be re-prompted in the same session by supplying task_id and prompt; choose mode=\"background\" to keep it detached or omit mode to wait for the queued continuation.",
  "Use background only for independent work that can run while you continue elsewhere; you will be notified automatically when it finishes.",
  "Use supervisor when you must stay responsible for the worker: inspect progress, audit evidence, and steer before integrating.",
  "When launching several independent subagents, call this tool several times in the SAME assistant message.",
].join(" ")

/**
 * Worker-side behavioral contract appended to the prompt only under supervisor
 * mode. It is deliberately compact and does not require periodic status
 * reports; the supervisor inspects the Session instead.
 */
export const SUPERVISOR_WORKER_PROTOCOL = [
  "## SUPERVISOR WORKER PROTOCOL",
  "You are an independent worker under an active supervisor.",
  "Own the assigned scope and work autonomously; do not coordinate directly with sibling workers unless explicitly instructed.",
  "Stay inside your assigned scope. Surface blockers and material discoveries clearly, and state when evidence changes your planned approach.",
  "Return concrete evidence: files, symbols, tests, findings, or artifacts - not merely a confidence statement.",
  "The supervisor owns cross-worker integration and final acceptance.",
  "Do not emit periodic status reports; complete the work and return your evidence.",
].join("\n")
const BACKGROUND_STARTED = [
  "The task is working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work ΓÇö avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
].join("\n")
const BACKGROUND_UPDATED = [
  "Additional context sent to the running background task.",
  "The task is still working in the background. You will be notified automatically when it finishes.",
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work ΓÇö avoid working with the same files or topics it is using.",
  "Work on non-overlapping tasks, or briefly tell the user what you sent and end your response.",
].join("\n")

const SUPERVISOR_STARTED = [
  "The supervised workers are running detached under your supervision. You remain responsible for them until they reach terminal states.",
  "Inspect the cohort when meaningful worker state changes occur: completion, failure, cancellation, a permission or question blocker, a material status change, or a finding that invalidates a sibling worker's assumption.",
  "Audit worker reasoning and evidence rather than trusting final responses. Steer workers that are blocked, drifting, duplicating, or out of scope; do not micromanage healthy workers or poll without a reason.",
  "Do not run a fixed-interval heartbeat or blind polling loop, and do not ask workers for periodic status reports.",
  "Do not finish the overarching task merely because workers are still running; own final synthesis and verification.",
].join("\n")

const SUPERVISOR_UPDATED = [
  "Guidance sent to the running supervised worker; it is still detached under your supervision.",
  "You remain responsible for the cohort. Inspect progress and evidence when it changes, and steer only when warranted.",
  "Do not finish the overarching task merely because workers are still running; own final synthesis and verification.",
].join("\n")

type DelegatedModelPolicy = {
  providerID: ProviderV2.ID
  modelID: ModelV2.ID
  accountID?: string
  variant?: string
  routeIntent?: ProviderRouteIntent.Info
}

type DelegatedTaskPolicy = {
  strict: true
  allowed: boolean
  model?: DelegatedModelPolicy
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function delegatedModel(value: unknown): DelegatedModelPolicy | undefined {
  const row = asRecord(value)
  const providerID = typeof row.providerID === "string" ? row.providerID.trim() : ""
  const modelID = typeof row.modelID === "string" ? row.modelID.trim() : ""
  if (!providerID || !modelID) return
  const accountID = typeof row.accountID === "string" && row.accountID.trim() ? row.accountID.trim() : undefined
  const variant = typeof row.variant === "string" && row.variant && row.variant !== "default" ? row.variant : undefined
  return {
    providerID: ProviderV2.ID.make(providerID),
    modelID: ModelV2.ID.make(modelID),
    ...(accountID ? { accountID } : {}),
    ...(variant ? { variant } : {}),
  }
}

function policyFromLocalMcp(value: unknown): DelegatedTaskPolicy | undefined {
  const local = asRecord(value)
  if (local.strictSubagentModelPolicy !== true) return
  const model = delegatedModel(local.subagentModelPolicy) ?? delegatedModel(local.modelSelection)
  return {
    strict: true,
    allowed: local.nestedSubagentsAllowed === true,
    ...(model ? { model } : {}),
  }
}

function policyFromWorkerDelegation(
  metadata: Readonly<Record<string, unknown>> | undefined,
): DelegatedTaskPolicy | undefined {
  const origin = SessionMetadataOwnership.workerDelegation(metadata)
  if (!origin) return
  return {
    strict: true,
    allowed: origin.nestedDelegation,
    model: {
      providerID: ProviderV2.ID.make(origin.model.providerID),
      modelID: ModelV2.ID.make(origin.model.modelID),
      ...(origin.model.accountID ? { accountID: origin.model.accountID } : {}),
      ...(origin.model.variant && origin.model.variant !== "default"
        ? { variant: origin.model.variant }
        : {}),
      routeIntent: origin.model.routeIntent,
    },
  }
}

function sameModel(
  left: {
    providerID: string
    modelID?: string
    id?: string
    accountID?: string
    variant?: string
    routeIntent?: ProviderRouteIntent.Info
  },
  right: DelegatedModelPolicy,
) {
  const leftID = left.modelID ?? left.id
  if (!leftID) return false
  return SessionMetadataOwnership.sameWorkerDelegationModel(
    {
      providerID: left.providerID,
      modelID: leftID,
      ...(left.accountID ? { accountID: left.accountID } : {}),
      ...(left.variant ? { variant: left.variant } : {}),
      ...(left.routeIntent ? { routeIntent: left.routeIntent } : {}),
    },
    {
      providerID: right.providerID,
      modelID: right.modelID,
      ...(right.accountID ? { accountID: right.accountID } : {}),
      ...(right.variant ? { variant: right.variant } : {}),
      ...(right.routeIntent ? { routeIntent: right.routeIntent } : {}),
    },
  )
}

export interface Input {
  readonly description: string
  readonly prompt?: string
  readonly subagentType: string
  readonly taskID?: string
  readonly command?: string
  readonly background?: boolean
  readonly mode?: TaskMode
}

export interface ExecutionContext {
  readonly parentSessionID: SessionID
  readonly assistantMessageID: MessageID
  readonly parentAgent: string
  readonly abort: AbortSignal
  readonly messages: SessionV1.WithParts[]
  readonly authorizedAgentNames?: ReadonlySet<string>
  readonly promptOps: SessionPromptOps
  readonly metadata: (input: { title?: string; metadata?: Record<string, any> }) => Effect.Effect<void>
  readonly ask: (input: Omit<PermissionV1.Request, "id" | "sessionID" | "tool">) => Effect.Effect<void>
}

export interface Result {
  readonly title: string
  readonly metadata: Record<string, any>
  readonly output: string
  readonly attachments?: Omit<SessionV1.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Interface {
  readonly execute: (input: Input, context: ExecutionContext) => Effect.Effect<Result, Error>
}

function renderOutput(input: {
  sessionID: SessionID
  state: "running" | "completed" | "error"
  summary?: string
  text: string
}) {
  const tag = input.state === "error" ? "task_error" : "task_result"
  const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  const safeText = input.text.replace(/<\/?(?:task|task_result|task_error)(?:\s|>)/gi, (match) =>
    match.replace("<", "&lt;").replace(">", "&gt;"),
  )
  return [
    `<task id="${escapeXml(input.sessionID)}" state="${input.state}">`,
    ...(input.summary ? [`<summary>${escapeXml(input.summary)}</summary>`] : []),
    `<${tag}>`,
    safeText,
    `</${tag}>`,
    "</task>",
  ].join("\n")
}

const MAX_PARTIAL_CHARS = 600

function truncatePartial(text: string) {
  const clean = text.trim()
  if (clean.length <= MAX_PARTIAL_CHARS) return clean
  return `${clean.slice(0, MAX_PARTIAL_CHARS)}… [truncated]`
}

function lastTextPart(parts: SessionV1.WithParts["parts"]) {
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part?.type === "text" && part.text.trim() !== "") return part.text
  }
  return undefined
}

function resumeHint(sessionID: SessionID) {
  return [
    `Work completed so far is preserved in session ${sessionID}; do not redo it from scratch.`,
    `Resume that session with full context by calling task again with task_id "${sessionID}" and a continuation prompt, or inspect it with the session tool (action "messages", sessionId "${sessionID}").`,
  ].join(" ")
}

function failRecoverable(sessionID: SessionID, error: string, parts: SessionV1.WithParts["parts"]) {
  const text = lastTextPart(parts)
  const partial = text ? `\n\nPartial progress before failure:\n${truncatePartial(text)}` : ""
  return Effect.fail(
    new Error(`Subagent failed (task_id: ${sessionID}): ${error}${partial}\n\n${resumeHint(sessionID)}`),
  )
}

export const make = Effect.gen(function* () {
    const agent = yield* Agent.Service
    const background = yield* BackgroundJob.Service
    const config = yield* Config.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope
    const database = yield* Database.Service

const execute: Interface["execute"] = Effect.fn("SubagentDelegation.execute")(function* (
      input: Input,
      context: ExecutionContext,
    ) {
      const cfg = yield* config.get()
      const promptText = input.prompt?.trim() ? input.prompt : undefined

      // Mode resolution is frozen for compatibility:
      //   mode ?? (background === true ? "background" : "foreground")
      // Combining both explicit signals is ambiguous and must fail loudly
      // rather than silently reconciling conflicting intent.
      if (input.mode !== undefined && input.background !== undefined) {
        return yield* Effect.fail(
          new Error(
            'Task accepts either explicit `mode` or the legacy `background` boolean, not both. Provide a single "mode" of "foreground", "background", or "supervisor" (or omit both for foreground).',
          ),
        )
      }
      const resolvedMode: TaskMode =
        input.mode ?? (input.background === true ? "background" : "foreground")
      const isSupervisor = resolvedMode === "supervisor"
      // Supervisor maps to detached execution; background boolean stays present
      // for compatibility. Foreground => false; background/supervisor => true.
      const runInBackground = resolvedMode !== "foreground"
      // Deterministic cohort identity: every supervisor call emitted in one
      // assistant turn shares the same group ID.
      const supervisionGroupID = `sup:${context.assistantMessageID}`

      const parent = yield* sessions.get(context.parentSessionID)
      let depth = 0
      let current = parent
      const visited = new Set<SessionID>([parent.id])
      while (current.parentID && depth < 64 && !visited.has(current.parentID)) {
        visited.add(current.parentID)
        depth++
        current = yield* sessions.get(current.parentID)
      }
      if (depth >= (cfg.subagent_depth ?? 1)) {
        return yield* Effect.fail(
          new Error(
            `Subagent depth limit reached (${cfg.subagent_depth ?? 1}). Increase "subagent_depth" to allow nested subagents.`,
          ),
        )
      }

      // Resolve the requested agent and enforce its delegation capability
      // BEFORE asking for Task permission. A prompt for an agent that can never
      // be delegated is a permission the user can approve that changes nothing,
      // so the ordering here is a correctness property, not a style choice.
      const next = yield* agent.get(input.subagentType)
      if (!next) {
        return yield* Effect.fail(new Error(`Unknown agent type: ${input.subagentType} is not a valid agent type`))
      }

      // `mode` is the canonical delegation capability. The Task tool description
      // already advertises only `mode !== "primary"` agents (ToolRegistry
      // .describeTask), so enforcing the same rule here — the single owner every
      // delegation path flows through, whether the model called the Task tool or
      // a `task` prompt input spawned the child — is what stops a model from
      // bypassing its own tool description by naming a primary agent.
      //
      // `hidden` is deliberately not consulted: it is a chooser-discoverability
      // flag, not a capability.
      //
      // Resume fails closed as well. A child session whose agent was switched to
      // `primary` after it started is refused instead of being silently
      // continued, so a capability change can never quietly re-grant
      // delegation for a task that began under the old mode. The user-facing
      // remedy is explicit in the error.
      if (next.mode === "primary") {
        return yield* Effect.fail(
          new Error(
            `Agent "${next.name}" is configured as a primary agent and cannot be used as a subagent. ` +
              `Set its "mode" to "subagent" or "all" in OpenFork configuration to delegate work to it.`,
          ),
        )
      }

      const authorizedAgentNames = context.authorizedAgentNames
      if (!authorizedAgentNames?.has(input.subagentType)) {
        yield* context.ask({
          permission: ID,
          patterns: [input.subagentType],
          always: ["*"],
          metadata: {
            description: input.description,
            subagent_type: input.subagentType,
          },
        })
      }

      const session = input.taskID
        ? yield* sessions.get(SessionID.make(input.taskID)).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        : undefined
      if (input.taskID && !session) {
        return yield* Effect.fail(
          new Error(`Unknown task_id "${input.taskID}". Omit task_id to start a new subagent instead of duplicating work.`),
        )
      }
      if (session && session.parentID !== context.parentSessionID) {
        return yield* Effect.fail(new Error(`Task ${session.id} does not belong to parent session ${context.parentSessionID}.`))
      }
      if (session?.agent && session.agent !== next.name) {
        return yield* Effect.fail(
          new Error(
            `Task ${session.id} belongs to @${session.agent}; resume it with subagent_type "${session.agent}" instead of "${next.name}".`,
          ),
        )
      }
      if (!session && !promptText) {
        return yield* Effect.fail(new Error("prompt is required when starting a new subagent task."))
      }

      const ops = context.promptOps
      if (!ops) return yield* Effect.fail(new Error("Subagent delegation requires Session prompt control"))

      const msg = yield* MessageV2.get({ sessionID: context.parentSessionID, messageID: context.assistantMessageID }).pipe(
        Effect.provideService(Database.Service, database),
        Effect.orDie,
      )
      if (msg.info.role !== "assistant") return yield* Effect.fail(new Error("Not an assistant message"))
      const parentMessageID =
        "parentID" in msg.info && typeof msg.info.parentID === "string" ? MessageID.make(msg.info.parentID) : undefined
      if (!parentMessageID) return yield* Effect.fail(new Error("Assistant message has no parent user turn"))
      const parentTurn =
        context.messages.find((message) => message.info.id === parentMessageID) ??
        (yield* MessageV2.get({ sessionID: context.parentSessionID, messageID: parentMessageID }).pipe(
          Effect.provideService(Database.Service, database),
          Effect.catchCause(() => Effect.succeed(undefined)),
        ))
      if (!parentTurn || parentTurn.info.role !== "user") {
        return yield* Effect.fail(
          new Error(
            `Task authorization parent ${parentMessageID} is unavailable or is not a user-role turn; refusing to infer delegated authority.`,
          ),
        )
      }
      let policyTurn = parentTurn
      const causalRootID = SessionTurnProvenance.causalRootMessageID(parentTurn)
      if (causalRootID && causalRootID !== parentTurn.info.id) {
        const resolvedPolicyTurn =
          context.messages.find((message) => message.info.id === causalRootID) ??
          (yield* MessageV2.get({ sessionID: context.parentSessionID, messageID: causalRootID }).pipe(
            Effect.provideService(Database.Service, database),
            Effect.catchCause(() => Effect.succeed(undefined)),
          ))
        if (!resolvedPolicyTurn || !SessionTurnProvenance.isWorkerPromptTurn(resolvedPolicyTurn)) {
          return yield* Effect.fail(
            new Error(
              `Task authorization root ${causalRootID} is unavailable or is not a worker prompt; refusing to infer authority from a host continuation.`,
            ),
          )
        }
        policyTurn = resolvedPolicyTurn
      }
      if (policyTurn && !SessionTurnProvenance.isWorkerPromptTurn(policyTurn)) {
        return yield* Effect.fail(
          new Error(
            `Task authorization parent ${policyTurn.info.id} is not a provenance-qualified worker prompt; refusing to infer delegated authority from provider role=user.`,
          ),
        )
      }
      // Turn-scoped delegated authority belongs to the causal worker root,
      // never to a host-authored continuation that merely lowers as
      // provider role=user. This prevents synthetic metadata from widening
      // nested-subagent permissions or changing the user-authorized model.
      const turnPolicy =
        policyTurn?.info.role === "user"
          ? policyTurn.parts
              .filter((part): part is SessionV1.TextPart => part.type === "text")
              .map((part) => policyFromLocalMcp(asRecord(part.metadata).localMcp))
              .find((policy): policy is DelegatedTaskPolicy => policy !== undefined)
          : undefined
      const oxpTurnPolicy =
        policyTurn?.info.role === "user" &&
        policyTurn.info.provenance?.owner === "host" &&
        policyTurn.info.provenance.source ===
          SessionTurnProvenance.Source.OxpDelegation
          ? policyTurn.parts
              .filter(
                (part): part is SessionV1.TextPart => part.type === "text",
              )
              .map((part) =>
                DelegatedWorkerPolicy.turnPolicy(
                  asRecord(part.metadata),
                ),
              )
              .find(
                (policy): policy is DelegatedWorkerPolicy.TurnPolicy =>
                  policy !== undefined,
              )
          : undefined
      const protectedDelegation = SessionMetadataOwnership.hasWorkerDelegationOrigin(parent.metadata)
      const protectedPolicy = policyFromWorkerDelegation(parent.metadata)
      if (protectedDelegation && !protectedPolicy) {
        return yield* Effect.fail(
          new Error(
            "Delegated worker policy is malformed; refusing nested subagent execution.",
          ),
        )
      }
      const legacySessionPolicy = policyFromLocalMcp(asRecord(parent.metadata).localMcp)
      // Protected producer-owned delegation policy is authoritative for an OXP
      // worker. Legacy LocalMCP turn/session metadata remains a compatibility
      // path only and can never widen or replace the protected envelope.
      if (protectedPolicy && !oxpTurnPolicy) {
        return yield* Effect.fail(
          new Error(
            "Delegated worker turn is missing its protected nested-delegation policy snapshot.",
          ),
        )
      }
      const delegatedPolicy = protectedPolicy
        ? {
            ...protectedPolicy,
            allowed:
              protectedPolicy.allowed &&
              oxpTurnPolicy!.nestedDelegation,
          }
        : turnPolicy ?? legacySessionPolicy
      if (delegatedPolicy && !delegatedPolicy.allowed) {
        return yield* Effect.fail(
          new Error("Nested subagent spawning is not authorized for this delegated worker."),
        )
      }
      if (delegatedPolicy && !delegatedPolicy.model) {
        return yield* Effect.fail(
          new Error(
            "Strict subagent model policy requires a user-authorized model. The agent may not choose, infer, or inherit a model for this task.",
          ),
        )
      }
      const strictModel = delegatedPolicy?.model
      if (session && strictModel) {
        const existingLocalMcp = asRecord(asRecord(session.metadata).localMcp)
        const protectedChild = SessionMetadataOwnership.workerDelegation(session.metadata)
        if (protectedPolicy && !protectedChild) {
          return yield* Effect.fail(
            new Error(
              "Task " +
                session.id +
                " is not part of the current protected delegation lineage. Spawn a new task instead of adopting an existing child.",
            ),
          )
        }
        const recorded =
          (protectedChild
            ? {
                providerID: ProviderV2.ID.make(protectedChild.model.providerID),
                modelID: ModelV2.ID.make(protectedChild.model.modelID),
                ...(protectedChild.model.accountID
                  ? { accountID: protectedChild.model.accountID }
                  : {}),
                ...(protectedChild.model.variant &&
                protectedChild.model.variant !== "default"
                  ? { variant: protectedChild.model.variant }
                  : {}),
                routeIntent: protectedChild.model.routeIntent,
              }
            : undefined) ?? delegatedModel(existingLocalMcp.modelSelection)
        const sessionModel = session.model
          ? {
              providerID: session.model.providerID,
              id: session.model.id,
              accountID: session.model.accountID,
              variant: session.model.variant,
            }
          : undefined
        const bound = recorded ?? (sessionModel && sameModel(sessionModel, strictModel) ? strictModel : undefined)
        if (!bound || !sameModel(bound, strictModel)) {
          return yield* Effect.fail(
            new Error(
              `Task ${session.id} is not bound to the current user-authorized subagent model ${strictModel.providerID}/${strictModel.modelID}. Spawn a new task instead of changing a resumed task model.`,
            ),
          )
        }
        if (!recorded) {
          // A legacy child whose durable model already matches may be resumed,
          // but upgrade it to the strict recursive policy before any new prompt
          // so its own descendants cannot fall back to agent/parent selection.
          yield* sessions.setMetadata({
            sessionID: session.id,
            metadata: {
              ...asRecord(session.metadata),
              localMcp: {
                ...existingLocalMcp,
                delegatedSubagent: true,
                strictSubagentModelPolicy: true,
                nestedSubagentsAllowed: true,
                modelSelection: {
                  providerID: strictModel.providerID,
                  modelID: strictModel.modelID,
                    ...(strictModel.accountID
                      ? { accountID: strictModel.accountID }
                      : {}),
                  variant: strictModel.variant ?? "default",
                  source: "inherited_user_policy",
                },
              },
            },
          })
        }
      }
      const parentVariant = msg.info.variant
      const model = strictModel ?? next.model ?? {
        modelID: msg.info.modelID,
        providerID: msg.info.providerID,
      }
      const taskVariant = strictModel ? strictModel.variant : next.model ? undefined : parentVariant
      const workerOrigin = SessionMetadataOwnership.workerDelegation(parent.metadata)
      const childPermission = deriveSubagentSessionPermission({
        parentSessionPermission: parent.permission ?? [],
        subagent: next,
        autoApproveAsks: parent.agent === "yolo" || context.parentAgent === "yolo",
      })
      const childToolDenies = [
        ...(next.permission.some((rule) => rule.permission === "todowrite")
          ? []
          : [{ permission: "todowrite" as const, pattern: "*" as const, action: "deny" as const }]),
        ...(next.permission.some((rule) => rule.permission === ID)
          ? []
          : [{ permission: ID, pattern: "*" as const, action: "deny" as const }]),
        ...(cfg.experimental?.primary_tools?.map((permission) => ({
          permission,
          pattern: "*" as const,
          action: "deny" as const,
        })) ?? []),
      ]
      const nextSession =
        session ??
        (yield* sessions.create({
          parentID: context.parentSessionID,
          title: input.description + ` (@${next.name} subagent)`,
          agent: next.name,
          ...(strictModel
            ? {
                model: {
                  providerID: strictModel.providerID,
                  id: strictModel.modelID,
                  ...(strictModel.accountID
                    ? { accountID: strictModel.accountID }
                    : {}),
                  ...(strictModel.variant ? { variant: strictModel.variant } : {}),
                },
                metadata: workerOrigin
                  ? SessionMetadataOwnership.delegatedWorker({
                      ...workerOrigin,
                      agent: next.name,
                      parentWorkerID: parent.id,
                      model: {
                        providerID: strictModel.providerID,
                        modelID: strictModel.modelID,
                        ...(strictModel.accountID
                          ? { accountID: strictModel.accountID }
                          : {}),
                        ...(strictModel.variant
                          ? { variant: strictModel.variant }
                          : {}),
                        ...(strictModel.routeIntent
                          ? { routeIntent: strictModel.routeIntent }
                          : {}),
                      },
                    })
                  : {
                      localMcp: {
                        delegatedSubagent: true,
                        strictSubagentModelPolicy: true,
                        nestedSubagentsAllowed: true,
                        modelSelection: {
                          providerID: strictModel.providerID,
                          modelID: strictModel.modelID,
                          ...(strictModel.accountID
                            ? { accountID: strictModel.accountID }
                            : {}),
                          variant: strictModel.variant ?? "default",
                          source: "inherited_user_policy",
                        },
                      },
                    },
              }
            : {}),
          permission: [
            ...childPermission,
            ...childToolDenies.filter(
              (deny) =>
                !childPermission.some(
                  (rule) =>
                    rule.permission === deny.permission && rule.pattern === deny.pattern && rule.action === deny.action,
                ),
            ),
          ],
        }))

      const metadata = {
        parentSessionId: context.parentSessionID,
        sessionId: nextSession.id,
        model,
        ...(taskVariant ? { variant: taskVariant } : {}),
        mode: resolvedMode,
        background: runInBackground,
        ...(isSupervisor
          ? {
              supervisorSessionId: context.parentSessionID,
              supervisionGroupId: supervisionGroupID,
            }
          : {}),
      }

      yield* context.metadata({
        title: input.description,
        metadata,
      })

      // Worker 4's supervision service is optional: consume it via serviceOption
      // so Task delegation compiles and works before/without the service.
      const supervisorRegistry = Option.getOrUndefined(yield* Effect.serviceOption(SupervisorRegistryTag))

      const delegationEnvelope: SubagentSupervisionMetadata.TaskDelegation | undefined = isSupervisor
        ? {
            mode: "supervisor",
            supervisorSessionID: context.parentSessionID,
            supervisionGroupID,
            description: input.description,
            createdFromMessageID: context.assistantMessageID,
          }
        : undefined

      // Durable supervision ownership lives on the child Session and is written
      // through the fork-local metadata helper (mutable/caller-replaceable, not
      // producer-owned identity). Non-supervisor modes strip/ignore it.
      const establishSupervision = Effect.fnUntraced(function* () {
        if (!delegationEnvelope) return
        const current = yield* sessions.get(nextSession.id)
        yield* sessions.setMetadata({
          sessionID: nextSession.id,
          metadata: SubagentSupervisionMetadata.withTaskDelegation(delegationEnvelope, current.metadata),
        })
        if (supervisorRegistry) {
          yield* supervisorRegistry.register({
            supervisorSessionID: context.parentSessionID,
            childSessionID: nextSession.id,
            supervisionGroupID,
            mode: "supervisor",
            description: input.description,
            createdFromMessageID: context.assistantMessageID,
          })
        }
      })

      // Relinquishing supervision keeps the child detached and running; it only
      // drops the active supervisory relationship.
      //
      // It is a strict no-op when the child carries no durable supervision
      // envelope and no supervision registry is present, so a plain foreground
      // task on a never-supervised child never mutates child metadata. The
      // durable `taskDelegation` strip is gated on `hasTaskDelegationOrigin`;
      // the live unregister is gated on an actual registry being installed.
      const relinquishSupervision = Effect.fnUntraced(function* () {
        if (!supervisorRegistry) {
          // No live registry: the only thing that can be relinquished is the
          // durable envelope. Skip the read entirely for a brand-new child that
          // cannot carry one.
          if (!input.taskID) return
        }
        const current = yield* sessions.get(nextSession.id)
        const supervised = SubagentSupervisionMetadata.hasTaskDelegationOrigin(current.metadata)
        if (supervisorRegistry) yield* supervisorRegistry.unregister(nextSession.id)
        if (supervised) {
          yield* sessions.setMetadata({
            sessionID: nextSession.id,
            metadata: SubagentSupervisionMetadata.withoutTaskDelegation(current.metadata),
          })
        }
      })

      const runTask = Effect.fn("SubagentDelegation.runTask")(function* (prompt: string) {
        const resolved = yield* ops.resolvePromptParts(prompt)
        // Supervisor workers receive the compact worker protocol; other modes
        // are byte-for-byte unchanged.
        const parts = isSupervisor
          ? [...resolved, { type: "text" as const, text: SUPERVISOR_WORKER_PROTOCOL }]
          : resolved
        const result = yield* ops.prompt(
          {
            messageID: MessageID.ascending(),
            sessionID: nextSession.id,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
              ...("accountID" in model && model.accountID
                ? { accountID: model.accountID }
                : {}),
            },
            variant: taskVariant,
            agent: next.name,
            parts,
          },
          workerOrigin
            ? {
                source: SessionTurnProvenance.Source.OxpDelegation,
                ref: workerOrigin.invocationRef,
                principalRef: workerOrigin.principalRef,
              }
            : undefined,
        )
        if (result.info.role === "assistant" && result.info.error) {
          const message =
            "message" in result.info.error.data && typeof result.info.error.data.message === "string"
              ? result.info.error.data.message
              : result.info.error.name
          return yield* failRecoverable(nextSession.id, message, result.parts)
        }
        const failed = result.parts.findLast((item) => item.type === "tool" && item.state.status === "error")
        if (failed?.type === "tool" && failed.state.status === "error") {
          return yield* failRecoverable(nextSession.id, failed.state.error ?? "unknown tool error", result.parts)
        }
        return result.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      // Safe-boundary supervisory steering. This is materially different from
      // `background.extend`, which only queues a continuation behind the
      // child's whole turn: `ops.steer` durably admits trusted host input to
      // the child's SessionInput inbox in the host `steer` lane, so the worker
      // reorients at its next safe provider-cycle boundary instead of waiting
      // for a post-completion continuation cycle. It never creates a second
      // child Session or a duplicate execution generation.
      const steerChild = Effect.fn("SubagentDelegation.steerChild")(function* (prompt: string) {
        const steer = ops.steer
        if (typeof steer !== "function") {
          // Fail loudly: silently downgrading supervisor steering to a queued
          // background continuation would re-create "renamed Background" and
          // violate the architectural invariant.
          return yield* Effect.die(
            new Error(
              "Supervisor steering requires SessionPromptOps.steer, but the prompt control surface did not provide it. Refusing to downgrade supervisor steering to a queued background continuation.",
            ),
          )
        }
        const resolved = yield* ops.resolvePromptParts(prompt)
        const parts = [...resolved, { type: "text" as const, text: SUPERVISOR_WORKER_PROTOCOL }]
        const steered = yield* steer.call(
          ops,
          {
            sessionID: nextSession.id,
            agent: next.name,
            model: {
              modelID: model.modelID,
              providerID: model.providerID,
              ...("accountID" in model && model.accountID ? { accountID: model.accountID } : {}),
            },
            variant: taskVariant,
            parts,
          },
          workerOrigin
            ? {
                source: SessionTurnProvenance.Source.OxpDelegation,
                ref: workerOrigin.invocationRef,
                principalRef: workerOrigin.principalRef,
              }
            : undefined,
        )
        if (steered.info.role === "assistant" && steered.info.error) {
          const message =
            "message" in steered.info.error.data && typeof steered.info.error.data.message === "string"
              ? steered.info.error.data.message
              : steered.info.error.name
          return yield* failRecoverable(nextSession.id, message, steered.parts)
        }
        return steered.parts.findLast((item) => item.type === "text")?.text ?? ""
      })

      const childTail = Effect.fn("SubagentDelegation.childTail")(function* (sessionID: SessionID) {
        const history = yield* sessions
          .messages({ sessionID })
          .pipe(Effect.catch(() => Effect.succeed([] as SessionV1.WithParts[])))
        for (let i = history.length - 1; i >= 0; i--) {
          const text = history[i] ? lastTextPart(history[i]!.parts) : undefined
          if (text) return truncatePartial(text)
        }
        return undefined
      })

      const inject = Effect.fn("SubagentDelegation.injectBackgroundResult")(function* (
        state: "completed" | "error",
        text: string,
      ) {
        const currentParent = yield* sessions.get(context.parentSessionID)
        const currentRoot = yield* sessions
          .findMessage(context.parentSessionID, SessionTurnProvenance.isWorkerPromptTurn)
          .pipe(Effect.orDie)
        if (Option.isNone(currentRoot) || currentRoot.value.info.role !== "user") {
          yield* Effect.logWarning("dropping background task notification without a live worker root", {
            parentSessionID: context.parentSessionID,
            childSessionID: nextSession.id,
          })
          return
        }
        yield* ops
          .prompt({
            sessionID: context.parentSessionID,
            agent: currentParent.agent ?? context.parentAgent,
            variant: parentVariant,
            parts: [
              {
                type: "text",
                synthetic: true,
                text: renderOutput({
                  sessionID: nextSession.id,
                  state,
                  summary:
                    state === "completed"
                      ? `Background task completed: ${input.description}`
                      : `Background task failed: ${input.description}`,
                  text,
                }),
              },
            ],
          }, {
            source: SessionTurnProvenance.Source.TaskSummary,
            sourceMessageID: currentRoot.value.info.id,
            ref: nextSession.id,
          })
          .pipe(Effect.ignore, Effect.forkIn(scope, { startImmediately: true }))
      })

      const notify = Effect.fn("SubagentDelegation.notifyBackgroundResult")(function* (jobID: string) {
        yield* background.wait({ id: jobID }).pipe(
          Effect.flatMap((result) =>
            Effect.gen(function* () {
              const completed = result.info
              if (!completed) return
              const latest = yield* background.get(jobID)
              const stillSameGeneration =
                completed.generation !== undefined && latest?.generation === completed.generation
              const backgroundAtDelivery = stillSameGeneration
                ? latest?.metadata?.background === true
                : completed.metadata?.background === true
              if (!backgroundAtDelivery) return
              if (completed.status === "completed") return yield* inject("completed", completed.output ?? "")
              if (completed.status === "error") return yield* inject("error", completed.error ?? "")
            }),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )
      })

      function backgroundResult(summary: string, text: string) {
        return {
          title: input.description,
          metadata: {
            ...metadata,
            background: true,
            jobId: nextSession.id,
          },
          output: renderOutput({
            sessionID: nextSession.id,
            state: "running",
            summary,
            text,
          }),
        }
      }

      const promotionMetadata = context.metadata({
        title: input.description,
        metadata: { ...metadata, background: true, jobId: nextSession.id },
      })

      const waitForeground = Effect.fn("SubagentDelegation.waitForeground")(function* () {
        const runCancel = yield* EffectBridge.make()
        // Once foreground Task cancellation begins, quiescing the owned child
        // Session is cleanup, not optional follow-up work. A parent runner
        // interruption may race the BackgroundJob cancelled notification; make
        // the child barrier uninterruptible so authority cannot return to the
        // parent while the child remains live.
        const cancel = ops.cancel(nextSession.id).pipe(Effect.uninterruptible)

        function onAbort() {
          runCancel.fork(cancel)
        }

        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            context.abort.addEventListener("abort", onAbort)
            if (context.abort.aborted) onAbort()
          }),
          () =>
            Effect.gen(function* () {
              const result = yield* Effect.raceFirst(
                background.wait({ id: nextSession.id }).pipe(Effect.map((waited) => waited.info)),
                background.waitForPromotion(nextSession.id),
              )
              if (!result) return yield* Effect.fail(new Error(`Subagent job disappeared (task_id: ${nextSession.id}).`))
              if (result.metadata?.background === true) {
                return backgroundResult("Task moved to background", BACKGROUND_STARTED)
              }
              if (result.status === "error") return yield* Effect.fail(new Error(result.error ?? "Task failed"))
              if (result.status === "cancelled") {
                // Foreground Task cancellation owns child execution cancellation.
                // Do not rely on a model-tool AbortSignal side channel: callers
                // such as SessionPrompt may cancel the parent-owned BackgroundJob
                // directly, which wakes this wait as an ordinary cancelled state
                // rather than an Effect interruption. The delegation backend must
                // establish child Session quiescence before reporting settlement.
                yield* cancel
                const tail = yield* childTail(nextSession.id)
                const partial = tail ? `\n\nPartial progress before cancellation:\n${tail}` : ""
                return yield* Effect.fail(
                  new Error(`Task cancelled (task_id: ${nextSession.id}).${partial}\n\n${resumeHint(nextSession.id)}`),
                )
              }
              return {
                title: input.description,
                metadata: { ...metadata, background: false },
                output: renderOutput({ sessionID: nextSession.id, state: "completed", text: result.output ?? "" }),
              }
            }),
          (_, exit) =>
            Effect.gen(function* () {
              if (Exit.hasInterrupts(exit))
                yield* Effect.all([cancel, background.cancel(nextSession.id)], { discard: true })
            }).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  context.abort.removeEventListener("abort", onAbort)
                }),
              ),
            ),
        )
      })

      const existingJob = yield* background.get(nextSession.id)
      if (existingJob?.status === "running") {
        if (existingJob.type !== ID) {
          return yield* Effect.fail(new Error(`Task session ${nextSession.id} is owned by running ${existingJob.type} job.`))
        }

        if (runInBackground) {
          const detached =
            existingJob.metadata?.background === true ? existingJob : yield* background.promote(nextSession.id)
          if (detached?.status === "running") {
            if (isSupervisor) {
              // Adopt (or re-affirm) supervision of the running worker without
              // restarting it. A prompt-bearing supervisor call is genuine
              // safe-boundary steering (ops.steer), NOT a queued continuation,
              // and never starts a new execution generation.
              yield* establishSupervision()
              if (!promptText) return backgroundResult("Worker adopted into supervision", SUPERVISOR_STARTED)
              yield* steerChild(promptText)
              return backgroundResult("Supervised worker steered", SUPERVISOR_UPDATED)
            } else {
              // mode:"background" on an existing running worker relinquishes
              // supervision (if any) while leaving the worker detached. Its
              // queued-continuation semantics stay EXACTLY as they were.
              yield* relinquishSupervision()
              if (!promptText) return backgroundResult("Task running in background", BACKGROUND_STARTED)
              const extended = yield* background.extend({
                id: nextSession.id,
                run: runTask(promptText).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
              })
              if (extended) return backgroundResult("Background task updated", BACKGROUND_UPDATED)
            }
          }
        } else {
          const attached = yield* background.foreground(nextSession.id, promotionMetadata)
          if (attached?.status === "running") {
            // Supervisor -> foreground attaches without restart and drops the
            // active supervisory relationship.
            yield* relinquishSupervision()
            if (!promptText) return yield* waitForeground()
            const extended = yield* background.extend({
              id: nextSession.id,
              run: runTask(promptText).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id))),
            })
            if (extended) return yield* waitForeground()
          }
        }
      }

      if (!promptText) {
        const previous = yield* background.get(nextSession.id)
        if (previous?.status === "completed") {
          if (previous.metadata?.background === true) yield* background.foreground(nextSession.id)
          if (isSupervisor) yield* establishSupervision()
          else yield* relinquishSupervision()
          return {
            title: input.description,
            metadata: { ...metadata, background: false },
            output: renderOutput({ sessionID: nextSession.id, state: "completed", text: previous.output ?? "" }),
          }
        }
        if (previous?.status === "error") {
          if (previous.metadata?.background === true) yield* background.foreground(nextSession.id)
          if (!isSupervisor) yield* relinquishSupervision()
          return yield* Effect.fail(new Error(previous.error ?? "Task failed"))
        }
        return yield* Effect.fail(
          new Error(
            input.taskID
              ? `Task ${nextSession.id} is not currently running; provide prompt to continue that child session.`
              : "prompt is required when starting a new subagent task.",
          ),
        )
      }

      const runPrompt = () => runTask(promptText).pipe(Effect.onInterrupt(() => ops.cancel(nextSession.id)))
      while (true) {
        const attempt = yield* background.tryStart({
          id: nextSession.id,
          type: ID,
          title: input.description,
          metadata,
          onPromote: promotionMetadata,
          continueOnFailure: true,
          run: runPrompt(),
        })
        if (attempt.started) {
          yield* notify(attempt.info.id)
          if (isSupervisor) {
            yield* establishSupervision()
            return backgroundResult("Supervised worker started", SUPERVISOR_STARTED)
          }
          if (runInBackground) {
            yield* relinquishSupervision()
            return backgroundResult("Background task started", BACKGROUND_STARTED)
          }
          return yield* waitForeground()
        }
        if (attempt.info.type !== ID) {
          return yield* Effect.fail(
            new Error(`Task session ${nextSession.id} is owned by running ${attempt.info.type} job.`),
          )
        }

        if (runInBackground) {
          const detached =
            attempt.info.metadata?.background === true ? attempt.info : yield* background.promote(nextSession.id)
          if (detached?.status !== "running") continue
          if (isSupervisor) {
            // The child is already running, so a prompt-bearing supervisor call
            // is safe-boundary steering, not a queued continuation.
            yield* establishSupervision()
            yield* steerChild(promptText)
            return backgroundResult("Supervised worker steered", SUPERVISOR_UPDATED)
          }
          yield* relinquishSupervision()
          if (yield* background.extend({ id: nextSession.id, run: runPrompt() })) {
            return backgroundResult("Background task updated", BACKGROUND_UPDATED)
          }
          continue
        }

        const attached = yield* background.foreground(nextSession.id, promotionMetadata)
        if (attached?.status !== "running") continue
        if (yield* background.extend({ id: nextSession.id, run: runPrompt() })) {
          return yield* waitForeground()
        }
      }
    })



    return { execute } satisfies Interface
})

export * as SubagentDelegation from "./subagent-delegation"
