import { Cause, Context, Duration, Effect, Exit, Layer, Ref } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Goal } from "@opencode-ai/core/goal"
import { Goal as GoalModel } from "@opencode-ai/schema/goal"
import { AppProcess } from "@opencode-ai/core/process"
import { GitRuntime } from "@opencode-ai/core/git-runtime"
import { ScheduledTask } from "@opencode-ai/core/scheduled-task"
import { ScheduledTaskProvenance } from "@opencode-ai/core/scheduled-task/provenance"
import { ScheduledTaskSessionBinding } from "@opencode-ai/core/scheduled-task/session-binding"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMetadataOwnership } from "@opencode-ai/core/session/metadata-ownership"
import { EventV2 } from "@opencode-ai/core/event"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Worktree } from "@/worktree"
import { ToolRegistry } from "@/tool/registry"
import { ScheduledTaskSessionAdmission } from "./session-admission"
import { fileURLToPath } from "node:url"

/**
 * TIER 3 BOUNDARY (03-execution-and-safety.md § 1).
 *
 * This is the only component in the feature allowed to materialize an
 * Instance. The contract returns `Effect<ExecutionOutcome>` with NO error
 * channel: an executor that can fail the effect can strand a lease and leave a
 * run row in `running` forever, so every failure mode is encoded in the value
 * and settlement is unconditional.
 *
 * It never reads `process.cwd()`. A missing target directory ends the run as
 * `skipped / target_missing` BEFORE any instance load.
 */
export interface ExecutionOutcome {
  readonly status: "succeeded" | "failed" | "skipped"
  readonly skipReason?: ScheduledTask.SkipReason
  readonly errorKind?: ScheduledTask.ErrorKind
  readonly errorMessage?: string
  readonly sessionID?: SessionID
  readonly directory?: string
}

export interface ExecuteInput {
  readonly task: ScheduledTask.Info
  readonly runID: ScheduledTask.RunID
  readonly attempt: number
  readonly fireFor: number
  readonly leaseID: string
}

export interface Interface {
  readonly execute: (input: ExecuteInput) => Effect.Effect<ExecutionOutcome>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ScheduledTaskExecutor") {}

/**
 * Scheduled Goals are unattended by default because the scheduler is the
 * initiating producer. Resource/attempt limits belong to ScheduledTask policy;
 * Goal continuation limits remain opt-in and are never silently injected here.
 */
export const SCHEDULED_GOAL_DEFAULTS = {
  mode: "unattended",
} as const

export function scheduledGoalPolicy(policy: GoalModel.ContinuationPolicy | undefined): GoalModel.ContinuationPolicy {
  return {
    mode: policy?.mode ?? SCHEDULED_GOAL_DEFAULTS.mode,
    ...(policy?.maxConsecutiveTurns !== undefined ? { maxConsecutiveTurns: policy.maxConsecutiveTurns } : {}),
    ...(policy?.maxNoProgressTurns !== undefined ? { maxNoProgressTurns: policy.maxNoProgressTurns } : {}),
    ...(policy?.maxDurationMs !== undefined ? { maxDurationMs: policy.maxDurationMs } : {}),
    ...(policy?.tokenBudget !== undefined ? { tokenBudget: policy.tokenBudget } : {}),
  }
}

class ScheduledConfigError extends Error {
  constructor(reason: string) {
    super(`scheduled config: ${reason}`)
  }
}

type ExecutionModelRef = SessionInput.SyntheticExecution["model"]
type ExecutionProfile = {
  readonly agent: string
  readonly model: ExecutionModelRef
  readonly execution: SessionInput.SyntheticExecution
  readonly providerModel: Provider.Model
}
type SessionSelection = {
  readonly session: Session.Info
  readonly binding?: ScheduledTaskSessionBinding.Binding
  readonly userFence?: { readonly expectedLatestUserSeq: number | undefined }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const permission = yield* Permission.Service
    const goals = yield* Goal.Service
    const worktree = yield* Worktree.Service
    const appProcess = yield* AppProcess.Service
    const events = yield* EventV2.Service
    const tasks = yield* ScheduledTask.Service
    const bindings = yield* ScheduledTaskSessionBinding.Service
    const admission = yield* ScheduledTaskSessionAdmission.Service
    const agents = yield* Agent.Service
    const providers = yield* Provider.Service
    const registry = yield* ToolRegistry.Service

    const sessionCompatibilityReason = (
      task: ScheduledTask.Info,
      session: Session.Info,
      directory: string,
      requireTaskOwned: boolean,
    ) => {
      if (session.parentID) return "Scheduled Task Session must be a root Session"
      if (task.projectID && session.projectID !== task.projectID) {
        return `Session project mismatch: ${session.projectID} != ${task.projectID}`
      }
      if (session.directory !== directory) {
        return `Session directory mismatch: ${session.directory} != ${directory}`
      }
      if (
        SessionMetadataOwnership.isSpecialAgent(session.metadata ?? undefined) ||
        SessionMetadataOwnership.hasWorkerDelegationOrigin(session.metadata ?? undefined)
      ) {
        return "special-agent/delegated Sessions cannot be Scheduled Task execution roots"
      }
      const hasScheduledOwner = SessionMetadataOwnership.hasScheduledTaskOrigin(session.metadata ?? undefined)
      const scheduled = ScheduledTaskProvenance.parseSessionMetadata(session.metadata)
      if (requireTaskOwned) {
        if (!scheduled || scheduled.scheduledTaskID !== task.id) {
          return "reusable Session is not owned by this Scheduled Task"
        }
      } else if (hasScheduledOwner && (!scheduled || scheduled.scheduledTaskID !== task.id)) {
        return "pinned Session is owned by another Scheduled Task or has malformed Scheduled ownership metadata"
      }
      return undefined
    }

    const execute = Effect.fn("ScheduledTaskExecutor.execute")(function* (input: ExecuteInput) {
      const task = input.task
      if (task.sessionPolicy.kind === "existing" && task.target.kind !== "directory") {
        return {
          status: "failed",
          errorKind: "config",
          errorMessage: "existing Session policy requires target.kind=directory",
          directory: task.targetDirectory,
        } satisfies ExecutionOutcome
      }
      const pinned =
        task.sessionPolicy.kind === "existing"
          ? yield* sessions.get(task.sessionPolicy.sessionID).pipe(Effect.option)
          : undefined
      if (task.sessionPolicy.kind === "existing" && pinned?._tag !== "Some") {
        return {
          status: "failed",
          errorKind: "config",
          errorMessage: `pinned Session not found: ${task.sessionPolicy.sessionID}`,
          directory: task.targetDirectory,
        } satisfies ExecutionOutcome
      }
      const pinnedSession = pinned?._tag === "Some" ? pinned.value : undefined
      const pinnedMismatch = pinnedSession
        ? sessionCompatibilityReason(task, pinnedSession, task.targetDirectory, false)
        : undefined
      if (pinnedSession && pinnedMismatch) {
        return {
          status: "failed",
          errorKind: "config",
          errorMessage: pinnedMismatch,
          sessionID: pinnedSession.id,
          directory: task.targetDirectory,
        } satisfies ExecutionOutcome
      }
      const targetDirectory = task.targetDirectory
      // Step 3: stat the target before any instance load. Missing location is
      // toxic and never resolves to process.cwd().
      const isDirectory = yield* fs.isDir(targetDirectory).pipe(Effect.orDie)
      if (!isDirectory) {
        return {
          status: "skipped",
          skipReason: "target_missing",
          directory: targetDirectory,
        } satisfies ExecutionOutcome
      }

      // Target resolution (03 § 2): worktree creation failure is a failure,
      // never a silent demotion to directory mode.
      let directory = targetDirectory
      if (task.target.kind === "worktree") {
        const prepared = yield* store
          .provide({ directory: task.targetDirectory }, prepareWorktree(task))
          .pipe(Effect.exit)
        if (Exit.isFailure(prepared)) {
          return {
            status: "failed",
            errorKind: "internal",
            errorMessage: `worktree preparation failed: ${causeText(prepared.cause)}`,
            directory: task.targetDirectory,
          } satisfies ExecutionOutcome
        }
        directory = prepared.value
      }

      // Step 6: TIER 3 BEGINS — the only InstanceStore materialization.
      return yield* Effect.scoped(
        store.provide(
          { directory },
          run({ task, runID: input.runID, attempt: input.attempt, fireFor: input.fireFor, directory, pinnedSession }),
        ),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(
            classify(causeText(cause), {
              status: "failed" as const,
              errorKind: "internal" as const,
              errorMessage: causeText(cause),
              directory,
            }),
          ),
        ),
      )
    })

    const prepareWorktree = Effect.fn("ScheduledTaskExecutor.prepareWorktree")(function* (task: ScheduledTask.Info) {
      if (task.target.kind !== "worktree") return task.targetDirectory
      if (task.target.reuse !== true) {
        return yield* Effect.die(new Error("per-run worktrees are not supported in v1"))
      }
      const slug = `scheduled-${task.id}`
      const existing = yield* worktree
        .list()
        .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<{ name: string; directory: string; branch?: string }>)))
      const match = existing.find(
        (entry) => entry.name.toLowerCase() === slug.toLowerCase() || entry.branch === `opencode/${slug}`,
      )
      const baseRef = task.target.baseRef?.trim() || "HEAD"
      if (match) {
        // One stable worktree per task, reset to the requested base at the
        // start of every run (03 § 2.2 — one worktree per task, not per run).
        yield* git(["reset", "--hard", baseRef], match.directory)
        yield* git(["clean", "-fd"], match.directory)
        return match.directory
      }
      const info = yield* worktree.create({ name: slug })
      yield* git(["reset", "--hard", baseRef], info.directory)
      return info.directory
    })

    const run = Effect.fn("ScheduledTaskExecutor.run")(function* (input: {
      task: ScheduledTask.Info
      runID: ScheduledTask.RunID
      attempt: number
      fireFor: number
      directory: string
      pinnedSession?: Session.Info
    }) {
      const { task, runID } = input
      const instance = yield* InstanceRef
      const sessionRef = yield* Ref.make<SessionID | undefined>(undefined)

      // Permission policy first, before any session exists, so an ask can
      // never race the policy: `deny` auto-rejects; `pause` parks as waiting.
      if (task.policy.permission !== "inherit") {
        const unsubscribe = yield* events.listen((event) =>
          Effect.gen(function* () {
            const data = event.data as { sessionID?: string; id?: string }
            const sessionID = yield* Ref.get(sessionRef)
            if (!sessionID || data.sessionID !== sessionID) return
            if (event.type === "permission.asked" && task.policy.permission === "deny" && data.id) {
              yield* permission
                .reply({ requestID: PermissionV1.ID.make(data.id), reply: "reject" })
                .pipe(Effect.provideService(InstanceRef, instance), Effect.ignore)
              return
            }
            if (event.type === "permission.asked" && task.policy.permission === "pause") {
              yield* tasks
                .markRunStatus({ runID, attempt: input.attempt, status: "waiting", now: Date.now() })
                .pipe(Effect.ignore)
              return
            }
            if (event.type === "permission.replied" && task.policy.permission === "pause") {
              yield* tasks
                .markRunStatus({ runID, attempt: input.attempt, status: "running", now: Date.now() })
                .pipe(Effect.ignore)
            }
          }),
        )
        yield* Effect.addFinalizer(() => unsubscribe)
      }

      const executionProfile = Effect.fn("ScheduledTaskExecutor.executionProfile")(function* (existing?: Session.Info) {
        const agent = task.action.agent ? yield* agents.get(task.action.agent) : yield* agents.defaultInfo()
        if (!agent) {
          return yield* Effect.die(new ScheduledConfigError(`agent not found: ${task.action.agent ?? "<default>"}`))
        }

        const base: ExecutionModelRef | undefined = task.action.model
          ? {
              id: task.action.model.id,
              providerID: task.action.model.providerID,
              ...(task.action.model.accountID ? { accountID: task.action.model.accountID } : {}),
              ...(task.action.model.variant ? { variant: task.action.model.variant } : {}),
            }
          : agent.model
            ? {
                id: agent.model.modelID,
                providerID: agent.model.providerID,
                ...(agent.model.accountID ? { accountID: agent.model.accountID } : {}),
                ...(agent.variant ? { variant: agent.variant as never } : {}),
              }
            : existing?.model
              ? {
                  id: existing.model.id,
                  providerID: existing.model.providerID,
                  ...(existing.model.accountID ? { accountID: existing.model.accountID } : {}),
                  ...(existing.model.variant && existing.model.variant !== "default"
                    ? { variant: existing.model.variant as never }
                    : {}),
                }
              : (() => undefined)()

        const selected: ExecutionModelRef =
          base ??
          (yield* providers
            .defaultModel()
            .pipe(
              Effect.map((model): ExecutionModelRef => ({ id: model.modelID, providerID: model.providerID })),
              Effect.catch((error) =>
                Effect.die(
                  new ScheduledConfigError(
                    `no usable default model: ${error instanceof Error ? error.message : String(error)}`,
                  ),
                ),
              ),
            ))

        const resolved = yield* providers
          .getModel(selected.providerID, selected.id, selected.accountID)
          .pipe(
            Effect.catch((error) =>
              Effect.die(
                new ScheduledConfigError(
                  `model unavailable: ${selected.providerID}/${selected.id}: ${error instanceof Error ? error.message : String(error)}`,
                ),
              ),
            ),
          )
        const sameAgentModel =
          agent.model?.providerID === selected.providerID && agent.model?.modelID === selected.id
        const variant =
          selected.variant ??
          (sameAgentModel && agent.variant && resolved.variants?.[agent.variant] ? (agent.variant as never) : undefined)
        const model: ExecutionModelRef = {
          id: selected.id,
          providerID: selected.providerID,
          ...(selected.accountID ? { accountID: selected.accountID } : {}),
          ...(variant ? { variant } : {}),
        }
        return {
          agent: agent.name,
          model,
          execution: { agent: agent.name, model },
          providerModel: resolved,
        } satisfies ExecutionProfile
      })

      const createSession = Effect.fn("ScheduledTaskExecutor.createSession")(function* () {
        return yield* sessions.create({
          title: `${task.name} — ${new Date(input.fireFor).toISOString()}`,
          metadata: ScheduledTaskProvenance.taskSessionMetadata({ taskID: task.id }),
        })
      })

      const boundSession = Effect.fn("ScheduledTaskExecutor.boundSession")(function* (sessionID: SessionID) {
        const found = yield* sessions.get(sessionID).pipe(Effect.option)
        if (found._tag === "None") return undefined
        const reason = sessionCompatibilityReason(task, found.value, input.directory, true)
        if (reason) return yield* Effect.die(new ScheduledConfigError(reason))
        return found.value
      })

      const installFreshAnchor = Effect.fn("ScheduledTaskExecutor.installFreshAnchor")(function* (
        expectedGeneration: number | undefined,
      ) {
        const fresh = yield* createSession()
        const installed = yield* bindings
          .install({
            taskID: task.id,
            taskRevision: task.revision,
            sessionID: fresh.id,
            expectedGeneration,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.die(new ScheduledConfigError(error instanceof Error ? error.message : String(error))),
            ),
          )
        if (installed) return { session: fresh, binding: installed }

        // A concurrent executor won the generation CAS. The losing candidate
        // was never authoritative, so remove it and converge on the winner.
        yield* sessions.remove(fresh.id).pipe(Effect.ignore)
        const winner = yield* bindings.get(task.id)
        const winnerSession = winner ? yield* boundSession(winner.sessionID) : undefined
        if (!winner || !winnerSession) {
          return yield* Effect.die(new ScheduledConfigError("Session binding CAS lost without a valid winner"))
        }
        return { session: winnerSession, binding: winner }
      })

      const selectSession = Effect.fn("ScheduledTaskExecutor.selectSession")(function* () {
        if (task.sessionPolicy.kind === "existing") {
          const session = input.pinnedSession
          if (!session) return yield* Effect.die(new ScheduledConfigError("pinned Session disappeared before execution"))
          const reason = sessionCompatibilityReason(task, session, input.directory, false)
          if (reason) return yield* Effect.die(new ScheduledConfigError(reason))
          return { session } as const
        }
        if (task.sessionPolicy.kind === "new") return { session: yield* createSession() } as const

        if (task.sessionPolicy.kind === "reuse") {
          const current = yield* bindings.get(task.id)
          if (current) {
            const reusable = yield* boundSession(current.sessionID)
            if (reusable) return { session: reusable, binding: current } as const
          }
          return yield* installFreshAnchor(current?.generation)
        }

        const inspected = yield* bindings.inspectAuto(task.id)
        if (inspected && !inspected.userChanged) {
          const reusable = yield* boundSession(inspected.binding.sessionID)
          if (reusable) {
            return {
              session: reusable,
              binding: inspected.binding,
              userFence: { expectedLatestUserSeq: inspected.binding.userSeqFence },
            } as const
          }
        }
        const fresh = yield* installFreshAnchor(inspected?.binding.generation)
        return {
          ...fresh,
          userFence: { expectedLatestUserSeq: fresh.binding.userSeqFence },
        } as const
      })

      const attachAndConfigure = Effect.fn("ScheduledTaskExecutor.attachAndConfigure")(function* (
        selection: SessionSelection,
      ) {
        yield* Ref.set(sessionRef, selection.session.id)
        const attached = yield* tasks.attachRunSession({
          runID,
          attempt: input.attempt,
          sessionID: selection.session.id,
          directory: input.directory,
        })
        if (!attached) {
          return yield* Effect.die(
            new Error(`scheduled run ${runID} attempt ${input.attempt} lost ownership before Session binding`),
          )
        }

        const profile = yield* executionProfile(selection.session)
        const currentVariant =
          selection.session.model?.variant && selection.session.model.variant !== "default"
            ? selection.session.model.variant
            : undefined
        if (
          selection.session.agent !== profile.agent ||
          selection.session.model?.providerID !== profile.model.providerID ||
          selection.session.model?.id !== profile.model.id ||
          selection.session.model?.accountID !== profile.model.accountID ||
          currentVariant !== profile.model.variant
        ) {
          yield* sessions.setAgentModel({
            sessionID: selection.session.id,
            agent: profile.agent,
            model: { ...profile.model, variant: profile.model.variant ?? "default" },
            time: Date.now(),
          })
        }
        return profile
      })

      const lowerPrompt = Effect.fn("ScheduledTaskExecutor.lowerPrompt")(function* (
        sessionID: SessionID,
        profile: ExecutionProfile,
      ) {
        const parts = yield* prompt.resolvePromptParts(task.action.prompt)
        const blocks = parts
          .filter((part): part is Extract<(typeof parts)[number], { type: "text" }> => part.type === "text")
          .map((part) => part.text)
        const files: Array<{ uri: string; mime: string; name?: string }> = []
        const delegated = new Set<string>()
        const { read } = yield* registry.named()
        const controller = new AbortController()
        yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()))
        const messageID = SessionV1.MessageID.ascending(ScheduledTaskSessionAdmission.inputID(runID, input.attempt))

        for (const part of parts) {
          if (part.type === "agent") {
            delegated.add(part.name)
            blocks.push(
              `Use the above message and context to generate a prompt and call the task tool with subagent: ${part.name}. Invoked by the scheduled task; the trusted delegated envelope authorizes this exact agent.`,
            )
            continue
          }
          if (part.type !== "file") continue
          if (
            (part.mime === "text/plain" || part.mime === "application/x-directory") &&
            part.url.startsWith("file:")
          ) {
            const filepath = fileURLToPath(part.url)
            const result = yield* read.execute(
              { filePath: filepath },
              {
                sessionID,
                messageID,
                agent: profile.agent,
                abort: controller.signal,
                extra: { bypassCwdCheck: true, model: profile.providerModel },
                messages: [],
                metadata: () => Effect.void,
                ask: () => Effect.void,
              },
            )
            blocks.push(`Called the Read tool with the following input: ${JSON.stringify({ filePath: filepath })}`)
            blocks.push(result.output)
            continue
          }
          files.push({
            uri: part.url,
            mime: part.mime,
            ...(part.filename ? { name: part.filename } : {}),
          })
        }
        return {
          content: { text: blocks.join("\n\n"), ...(files.length ? { files } : {}) },
          ...(delegated.size
            ? { delegated: { authorizedAgentNames: [...delegated] as never } }
            : {}),
        }
      })

      let selection = yield* selectSession()
      let profile = yield* attachAndConfigure(selection)
      let rendered = yield* lowerPrompt(selection.session.id, profile)

      const admit = () =>
        admission.admit({
          runID,
          attempt: input.attempt,
          sessionID: selection.session.id,
          content: rendered.content,
          execution: profile.execution,
          ...(rendered.delegated ? { delegated: rendered.delegated } : {}),
          ...(selection.userFence ? { userFence: selection.userFence } : {}),
        })
      const isAdmissionFenceConflict = (error: unknown) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { readonly _tag?: unknown })._tag === "SessionInput.AdmissionFenceConflict"

      let admitted = yield* admit().pipe(Effect.exit)
      if (Exit.isFailure(admitted)) {
        const userFenceRaced = isAdmissionFenceConflict(Cause.squash(admitted.cause))
        if (
          !userFenceRaced ||
          task.sessionPolicy.kind !== "auto" ||
          selection.binding === undefined
        ) {
          return yield* Effect.failCause(admitted.cause)
        }

        // Human input won Auto's final TOCTOU fence. Rotate exactly once to a
        // fresh task-owned anchor, rebind this attempt, and retry against the
        // fresh Session's own User frontier.
        const fresh = yield* installFreshAnchor(selection.binding.generation)
        selection = {
          ...fresh,
          userFence: { expectedLatestUserSeq: fresh.binding.userSeqFence },
        }
        profile = yield* attachAndConfigure(selection)
        rendered = yield* lowerPrompt(selection.session.id, profile)
        admitted = yield* admit().pipe(Effect.exit)
        if (Exit.isFailure(admitted)) {
          const secondFenceRace = isAdmissionFenceConflict(Cause.squash(admitted.cause))
          if (secondFenceRace) {
            return yield* Effect.die(
              new Error("scheduled Auto admission aborted: User input raced the replacement Session"),
            )
          }
          return yield* Effect.failCause(admitted.cause)
        }
      }

      const executeAdmitted = Effect.gen(function* () {
        if (task.action.goal) {
          // Admission is already fenced to the final Session, so Auto rotation
          // cannot leave Goal state behind on the abandoned anchor. One logical
          // run owns at most one Goal across all retry attempts.
          const existingRunGoalID = yield* tasks
            .runGoal(runID)
            .pipe(Effect.catch((error) => Effect.die(new ScheduledConfigError(goalErrorText(error)))))
          const focused = yield* goals.focused(selection.session.id)

          if (existingRunGoalID) {
            const existing = yield* goals
              .get(existingRunGoalID)
              .pipe(Effect.catch((error) => Effect.die(new ScheduledConfigError(goalErrorText(error)))))
            if (Goal.GoalStateMachine.isTerminal(existing.goal.status)) {
              return yield* Effect.die(
                new ScheduledConfigError(`logical run ${runID} already owns a terminal Goal`),
              )
            }
            if (focused && focused.detail.goal.id !== existingRunGoalID) {
              return yield* Effect.die(
                new ScheduledConfigError(
                  `Session ${selection.session.id} is focused on another Goal while run ${runID} already owns ${existingRunGoalID}`,
                ),
              )
            }
            if (!focused) {
              yield* goals
                .focus({
                  goalID: existingRunGoalID,
                  sessionID: selection.session.id,
                  role: "owner",
                  actor: "system",
                  expectedCurrentGoalID: null,
                })
                .pipe(Effect.catch((error) => Effect.die(new ScheduledConfigError(goalErrorText(error)))))
            }
            if (existing.goal.status === "draft") {
              yield* goals
                .transition({
                  id: existingRunGoalID,
                  expectedRevision: existing.goal.revision,
                  action: "start",
                  actor: "system",
                })
                .pipe(Effect.catch((error) => Effect.die(new ScheduledConfigError(goalErrorText(error)))))
            } else if (existing.goal.status !== "active") {
              return yield* Effect.die(
                new ScheduledConfigError(
                  `logical run ${runID} owns a Goal in non-runnable state ${existing.goal.status}`,
                ),
              )
            }
          } else {
            // A reusable/pinned Session may already have a focus. Only a
            // terminal Goal proven to belong to an earlier run of this same
            // Scheduled Task may be replaced. The exact-focus CAS prevents a
            // concurrent human selection from being cleared.
            if (focused) {
              const owner = yield* tasks.goalOwner(focused.detail.goal.id)
              const terminal = Goal.GoalStateMachine.isTerminal(focused.detail.goal.status)
              if (!owner || owner.taskID !== task.id || !terminal) {
                return yield* Effect.die(
                  new ScheduledConfigError(
                    `Session ${selection.session.id} already has a focused Goal that this run cannot replace`,
                  ),
                )
              }
              const cleared = yield* goals.unfocusExpected({
                sessionID: selection.session.id,
                goalID: focused.detail.goal.id,
                actor: "system",
              })
              if (!cleared) {
                return yield* Effect.die(
                  new ScheduledConfigError("Session Goal focus changed while preparing the Scheduled run"),
                )
              }
            }

            const prepared = yield* goals
              .prepareForSession({
                sessionID: selection.session.id,
                title: task.action.goal.title,
                objective: task.action.goal.objective,
                criteria: task.action.goal.criteria ?? [],
                continuationPolicy: scheduledGoalPolicy(task.action.goal.continuationPolicy),
                start: true,
                actor: "system",
                requireFresh: true,
                expectedCurrentGoalID: null,
              })
              .pipe(Effect.catch((error) => Effect.die(new ScheduledConfigError(goalErrorText(error)))))
            const correlated = yield* tasks.attachRunGoal({
              runID,
              attempt: input.attempt,
              goalID: prepared.detail.goal.id,
            })
            if (!correlated) {
              // The Goal was created/focused atomically, but this executor lost
              // the run attempt before correlation. Remove only that exact
              // focus and terminalize the orphaned automatic Goal; never touch a
              // concurrently selected replacement focus.
              yield* goals
                .unfocusExpected({
                  sessionID: selection.session.id,
                  goalID: prepared.detail.goal.id,
                  actor: "system",
                })
                .pipe(Effect.ignore)
              if (!Goal.GoalStateMachine.isTerminal(prepared.detail.goal.status)) {
                yield* goals
                  .transition({
                    id: prepared.detail.goal.id,
                    expectedRevision: prepared.detail.goal.revision,
                    action: "cancel",
                    actor: "system",
                  })
                  .pipe(Effect.ignore)
              }
              return yield* Effect.die(
                new ScheduledConfigError(`run ${runID} lost ownership before Goal correlation`),
              )
            }
          }
        }
        return yield* admission.run(selection.session.id)
      }).pipe(
        Effect.onError(() => admission.revoke({ runID, attempt: input.attempt }).pipe(Effect.ignore)),
      )

      const settled = yield* executeAdmitted.pipe(
        Effect.map((message) => classifyMessage(message)),
        Effect.timeoutOrElse({
          duration: Duration.millis(task.policy.maxDurationMs),
          orElse: () => Effect.succeed("timeout" as const),
        }),
        Effect.catchCause((cause) =>
          Effect.succeed(
            classify(causeText(cause), {
              status: "failed" as const,
              errorKind: "internal" as const,
              errorMessage: causeText(cause),
            }),
          ),
        ),
      )

      if (settled === "timeout") {
        // Wall-clock ceiling: abort the session and settle as failed/timeout.
        yield* prompt.cancel(selection.session.id).pipe(Effect.ignore)
        yield* admission.revoke({ runID, attempt: input.attempt }).pipe(Effect.ignore)
        return {
          status: "failed",
          errorKind: "timeout",
          errorMessage: `run exceeded maxDurationMs (${task.policy.maxDurationMs})`,
          sessionID: selection.session.id,
          directory: input.directory,
        } satisfies ExecutionOutcome
      }
      return { ...settled, sessionID: selection.session.id, directory: input.directory } satisfies ExecutionOutcome
    })

    const git = (args: ReadonlyArray<string>, cwd: string) =>
      Effect.gen(function* () {
        const result = yield* appProcess.run(
          ChildProcess.make("git", GitRuntime.args(args), { cwd, extendEnv: true, stdin: "ignore" }),
        )
        if (result.exitCode !== 0) {
          return yield* Effect.die(
            new Error(`git ${args.join(" ")} failed: ${result.stderr.toString("utf8") || result.stdout.toString("utf8")}`),
          )
        }
        return result
      })

    return Service.of({ execute })

    function classifyMessage(message: SessionV1.WithParts): ExecutionOutcome {
      if (message.info.role !== "assistant") return { status: "succeeded" }
      const error = (message.info as { error?: { name?: string; data?: { statusCode?: number; isRetryable?: boolean }; message?: string } }).error
      if (!error) return { status: "succeeded" }
      const text = error.message ?? error.name ?? "assistant error"
      if (error.name === "ProviderAuthError") {
        return { status: "failed", errorKind: "auth", errorMessage: text }
      }
      if (error.name === "MessageAbortedError") {
        return { status: "failed", errorKind: "aborted", errorMessage: text }
      }
      if (error.name === "APIError") {
        if (error.data?.statusCode === 429) return { status: "failed", errorKind: "quota", errorMessage: text }
        if (error.data?.isRetryable) return { status: "failed", errorKind: "provider", errorMessage: text }
        return { status: "failed", errorKind: "provider", errorMessage: text }
      }
      if (error.name === "ContextOverflowError") {
        return { status: "failed", errorKind: "config", errorMessage: text }
      }
      return classify(text, { status: "failed", errorKind: "internal", errorMessage: text })
    }

    function classify(text: string, fallback: ExecutionOutcome): ExecutionOutcome {
      if (/scheduled config:|Scheduled task operation rejected:/i.test(text)) {
        return { ...fallback, status: "failed", errorKind: "config", errorMessage: text }
      }
      if (/quota|rate.?limit|429|insufficient/i.test(text)) {
        return { ...fallback, status: "failed", errorKind: "quota", errorMessage: text }
      }
      if (/unauthor|forbidden|401|403|auth/i.test(text)) {
        return { ...fallback, status: "failed", errorKind: "auth", errorMessage: text }
      }
      if (/timeout|timed out/i.test(text)) {
        return { ...fallback, status: "failed", errorKind: "timeout", errorMessage: text }
      }
      if (/aborted/i.test(text)) {
        return { ...fallback, status: "failed", errorKind: "aborted", errorMessage: text }
      }
      if (/fetch failed|ECONN|network|5\d\d/i.test(text)) {
        return { ...fallback, status: "failed", errorKind: "provider", errorMessage: text }
      }
      return { ...fallback, status: "failed", errorKind: fallback.errorKind ?? "internal", errorMessage: text }
    }

    function causeText(cause: Cause.Cause<unknown>): string {
      const errors = Cause.prettyErrors(cause)
      if (errors.length === 0) return "unknown failure"
      return errors.map((error) => (error instanceof Error ? error.message : String(error))).join("; ")
    }

    function goalErrorText(error: unknown): string {
      if (error instanceof Error && error.message) return error.message
      if (typeof error === "object" && error !== null && "reason" in error) {
        return String((error as { readonly reason?: unknown }).reason ?? "Goal operation failed")
      }
      return String(error)
    }
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    InstanceStore.node,
    FSUtil.node,
    Session.node,
    SessionPrompt.node,
    Permission.node,
    Goal.node,
    Worktree.node,
    AppProcess.node,
    EventV2.node,
    ScheduledTask.node,
    ScheduledTaskSessionBinding.node,
    ScheduledTaskSessionAdmission.node,
    Agent.node,
    Provider.node,
    ToolRegistry.node,
  ],
})

export * as ScheduledTaskExecutor from "./executor"
