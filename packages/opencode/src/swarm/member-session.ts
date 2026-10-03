export * as SwarmMemberSession from "./member-session"

import { Cause, Context, Effect, Exit, Layer, Schema } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Database } from "@opencode-ai/core/database/database"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionExecutionBoundary } from "@opencode-ai/core/session/execution-boundary"
import { MessageTable, SessionInputTable } from "@opencode-ai/core/session/sql"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmSchema } from "@opencode-ai/core/swarm/schema"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import { SwarmProfilePreflight } from "@/swarm/profile-preflight"
import { Worktree } from "@/worktree"
import { Git } from "@/git"
import { eq } from "drizzle-orm"

const MATERIALIZE_CONCURRENCY = 4

export function sessionIDForBinding(memberID: SwarmModel.MemberID, generation: number) {
  return SessionID.make(`ses_swarm_${memberID}_${generation}`)
}

export function worktreeNameForMember(memberID: SwarmModel.MemberID) {
  return `swarm-${memberID}`.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase()
}

export function effectiveBoundary(
  profile: SwarmModel.MemberExecutionProfile,
  workspace: SwarmModel.WorkspacePolicy,
) {
  if (workspace.mode !== "shared-read") return [...profile.permissionBoundary]
  // A shell command is not statically classifiable as read-only. Keep the
  // shared-read promise hard rather than allowing a saved bash approval to turn
  // a read-only member into a writer.
  return [
    ...profile.permissionBoundary,
    { action: "edit", resource: "*", effect: "deny" as const },
    { action: "bash", resource: "*", effect: "deny" as const },
  ]
}

export class MaterializationError extends Schema.TaggedErrorClass<MaterializationError>()(
  "SwarmMemberSession.MaterializationError",
  {
    swarmID: SwarmModel.ID,
    memberID: SwarmModel.MemberID,
    reason: Schema.String,
  },
) {}

export interface Materialized {
  readonly status: "bound" | "already_bound"
  readonly member: SwarmModel.Member
  readonly sessionID: SessionID
  readonly directory: string
  readonly recoveredSession: boolean
  readonly reusedWorktree: boolean
}

export interface ReconcileResult {
  readonly scanned: number
  readonly bound: number
  readonly alreadyBound: number
  readonly cleaned: number
  readonly preserved: number
  readonly failed: ReadonlyArray<{ readonly memberID: SwarmModel.MemberID; readonly reason: string }>
}

export interface Interface {
  readonly materialize: (input: {
    readonly swarmID: SwarmModel.ID
    readonly memberID: SwarmModel.MemberID
  }) => Effect.Effect<Materialized, MaterializationError | SwarmSchema.Error>
  readonly reconcile: (input?: {
    readonly projectID?: SwarmModel.Info["projectID"]
    readonly swarmID?: SwarmModel.ID
  }) => Effect.Effect<ReconcileResult>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SwarmMemberSession") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const swarms = yield* SwarmV2.Service
    const sessionStore = yield* SessionStore.Service
    const boundaries = yield* SessionExecutionBoundary.Service
    const { readDb } = yield* Database.Service
    const store = yield* InstanceStore.Service
    const fs = yield* FSUtil.Service
    const sessions = yield* Session.Service
    const profilePreflight = yield* SwarmProfilePreflight.Service
    const worktrees = yield* Worktree.Service
    const git = yield* Git.Service

    const fail = (target: SwarmV2.MemberSessionTarget, reason: string) =>
      new MaterializationError({ swarmID: target.swarm.id, memberID: target.member.id, reason })

    const requireRunnable = Effect.fn("SwarmMemberSession.requireRunnable")(function* (
      target: SwarmV2.MemberSessionTarget,
    ) {
      if (target.swarm.status !== "active") {
        return yield* fail(target, `Swarm is not active (${target.swarm.status}).`)
      }
      if (target.member.kind !== "managed_worker") {
        return yield* fail(target, `Member kind ${target.member.kind} is not runtime-managed.`)
      }
      if (target.member.lifecycle !== "active") {
        return yield* fail(target, `Member is not active (${target.member.lifecycle}).`)
      }
    })

    const checkRootDirectory = Effect.fn("SwarmMemberSession.checkRootDirectory")(function* (
      target: SwarmV2.MemberSessionTarget,
    ) {
      const exists = yield* fs.isDir(target.swarm.directory).pipe(Effect.orDie)
      if (!exists) return yield* fail(target, `Swarm directory does not exist: ${target.swarm.directory}`)
      const projectID = yield* store.provide(
        { directory: target.swarm.directory },
        Effect.gen(function* () {
          const instance = yield* InstanceRef
          if (!instance) return yield* fail(target, "Swarm directory did not materialize an Instance context.")
          return instance.project.id
        }),
      )
      if (projectID !== target.swarm.projectID) {
        return yield* fail(
          target,
          `Swarm directory resolved to project ${projectID}, expected ${target.swarm.projectID}.`,
        )
      }
    })

    const validateProfile = Effect.fn("SwarmMemberSession.validateProfile")(function* (
      target: SwarmV2.MemberSessionTarget,
      directory: string,
      profile: SwarmModel.MemberExecutionProfile,
    ) {
      // Delegate creation already ran the identical preflight before the first
      // durable write. Repeating it here through the same shared owner is what
      // keeps a recovery pass, a catalog drift, or a member reconfigure from
      // binding a Session the selected model cannot serve.
      return yield* store
        .provide({ directory }, profilePreflight.check({ directory, profile }))
        .pipe(Effect.catch((error) => Effect.fail(fail(target, error.reason))))
    })

    const resetCreatedWorktree = Effect.fn("SwarmMemberSession.resetCreatedWorktree")(function* (
      target: SwarmV2.MemberSessionTarget,
      directory: string,
      baseRef: string,
    ) {
      const result = yield* git.run(["reset", "--hard", baseRef], { cwd: directory })
      if (result.exitCode !== 0) {
        return yield* fail(
          target,
          `Unable to initialize member worktree from ${baseRef}: ${result.stderr.toString("utf8") || result.text()}`,
        )
      }
    })

    const resolveDirectory = Effect.fn("SwarmMemberSession.resolveDirectory")(function* (
      target: SwarmV2.MemberSessionTarget,
    ) {
      yield* checkRootDirectory(target)
      const workspacePolicy = target.member.workspacePolicy
      if (workspacePolicy.mode !== "worktree") {
        return { directory: target.swarm.directory, reusedWorktree: false }
      }

      const slug = worktreeNameForMember(target.member.id)
      return yield* store
        .provide(
          { directory: target.swarm.directory },
          Effect.gen(function* () {
            const existing = yield* worktrees.list()
            const match = existing.find(
              (entry) => entry.name.toLowerCase() === slug || entry.branch === `opencode/${slug}`,
            )
            if (match) return { directory: match.directory, reusedWorktree: true }

            // Worktree.create() deliberately chooses a suffixed fallback when
            // the branch already exists. That behavior is useful for ad-hoc UI
            // worktrees but violates stable managed-member workspace identity.
            const branch = yield* git.run(["show-ref", "--verify", "--quiet", `refs/heads/opencode/${slug}`], {
              cwd: target.swarm.directory,
            })
            if (branch.exitCode === 0) {
              return yield* fail(
                target,
                `Stable member branch opencode/${slug} exists without a registered worktree; refusing a suffixed replacement.`,
              )
            }

            const created = yield* worktrees.create({ name: slug })
            const baseRef = workspacePolicy.baseRef?.trim()
            if (baseRef) yield* resetCreatedWorktree(target, created.directory, baseRef)
            return { directory: created.directory, reusedWorktree: false }
          }),
        )
        .pipe(
          Effect.catch((error) =>
            error instanceof MaterializationError
              ? Effect.fail(error)
              : Effect.fail(fail(target, error instanceof Error ? error.message : String(error))),
          ),
        )
    })

    const candidateFor = (target: SwarmV2.MemberSessionTarget) =>
      sessionIDForBinding(target.member.id, target.member.bindingGeneration + 1)

    const emptySession = Effect.fn("SwarmMemberSession.emptySession")(function* (sessionID: SessionID) {
      const existing = yield* sessionStore.get(sessionID)
      if (!existing) return { empty: true, session: undefined }
      const input = yield* readDb
        .select({ id: SessionInputTable.id })
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      if (input) return { empty: false, session: existing }
      const message = yield* readDb
        .select({ id: MessageTable.id })
        .from(MessageTable)
        .where(eq(MessageTable.session_id, sessionID))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return { empty: message === undefined, session: existing }
    })

    const cleanupCandidate = Effect.fn("SwarmMemberSession.cleanupCandidate")(function* (sessionID: SessionID) {
      const state = yield* emptySession(sessionID)
      if (!state.session) return "missing" as const
      if (!state.empty) return "preserved" as const
      return yield* store
        .provide(
          { directory: state.session.location.directory },
          sessions.remove(sessionID).pipe(
            Effect.as("cleaned" as const),
            Effect.catch(() => Effect.succeed("preserved" as const)),
          ),
        )
        .pipe(Effect.catch(() => Effect.succeed("preserved" as const)))
    })

    const createAndBind = Effect.fn("SwarmMemberSession.createAndBind")(function* (
      target: SwarmV2.MemberSessionTarget,
      profile: SwarmModel.MemberExecutionProfile,
      directory: string,
      reusedWorktree: boolean,
    ) {
      const candidate = candidateFor(target)
      const before = (yield* sessionStore.get(candidate)) !== undefined

      const session = yield* store
        .provide(
          { directory },
          sessions.createManagedRoot({
            id: candidate,
            title: `${target.swarm.name} / ${target.member.name}`,
            agent: profile.agent,
            model: profile.model,
            ...(target.swarm.workspaceID ? { workspaceID: target.swarm.workspaceID } : {}),
          }),
        )
        .pipe(
          Effect.mapError((error) => fail(target, error.reason)),
          Effect.catchCause((cause) =>
            Effect.fail(
              fail(
                target,
                Cause.prettyErrors(cause)
                  .map((error) => error instanceof Error ? error.message : String(error))
                  .join("; ") || "managed Session creation failed",
              ),
            ),
          ),
        )
      if (session.projectID !== target.swarm.projectID || session.parentID !== undefined) {
        yield* cleanupCandidate(candidate)
        return yield* fail(
          target,
          `Candidate Session resolved outside the required root/project scope (${session.projectID}).`,
        )
      }

      // Install the hard ceiling before the Session becomes a schedulable Swarm
      // principal. Repeated recovery writes are harmless durable replacements.
      yield* boundaries.set(candidate, effectiveBoundary(profile, target.member.workspacePolicy)).pipe(
        Effect.mapError((error) => fail(target, error.message)),
      )

      const rebound = yield* swarms
        .rebindMember({
          swarmID: target.swarm.id,
          memberID: target.member.id,
          expectedBindingGeneration: target.member.bindingGeneration,
          sessionID: candidate,
        })
        .pipe(Effect.exit)

      if (Exit.isSuccess(rebound)) {
        return {
          status: "bound",
          member: rebound.value,
          sessionID: candidate,
          directory,
          recoveredSession: before,
          reusedWorktree,
        } satisfies Materialized
      }

      // A concurrent reconciler/operator may have changed the member after the
      // candidate Session was created. Re-read canonical state before deciding
      // whether this was a benign race or a failed materialization.
      const current = yield* swarms.memberSessionTarget(target.swarm.id, target.member.id).pipe(Effect.exit)
      if (Exit.isSuccess(current) && current.value.member.sessionID) {
        if (current.value.member.sessionID !== candidate) yield* cleanupCandidate(candidate)
        const boundSession = current.value.member.sessionID
        const bound = yield* sessionStore.get(boundSession)
        return {
          status: "already_bound",
          member: current.value.member,
          sessionID: boundSession,
          directory: bound?.location.directory ?? directory,
          recoveredSession: before,
          reusedWorktree,
        } satisfies Materialized
      }
      yield* cleanupCandidate(candidate)
      if (Exit.isFailure(current)) return yield* fail(target, "Member disappeared while binding its Session.")
      if (current.value.member.lifecycle !== "active" || current.value.swarm.status !== "active") {
        return yield* fail(
          current.value,
          `Member/Swarm became non-runnable while binding (${current.value.member.lifecycle}/${current.value.swarm.status}).`,
        )
      }
      const reason = Cause.prettyErrors(rebound.cause)
        .map((error) => error instanceof Error ? error.message : String(error))
        .join("; ")
      return yield* fail(target, reason || "Member binding failed.")
    })

    const materializeTarget = Effect.fn("SwarmMemberSession.materializeTarget")(function* (
      target: SwarmV2.MemberSessionTarget,
    ) {
      yield* requireRunnable(target)
      if (target.member.sessionID) {
        const existing = yield* sessionStore.get(target.member.sessionID)
        if (existing) {
          return {
            status: "already_bound",
            member: target.member,
            sessionID: target.member.sessionID,
            directory: existing.location.directory,
            recoveredSession: true,
            reusedWorktree: target.member.workspacePolicy.mode === "worktree",
          } satisfies Materialized
        }
        // FK normally clears this automatically on Session deletion. A missing
        // bound Session therefore signals a transient/corrupt projection rather
        // than permission to mutate the binding behind Core's fence.
        return yield* fail(target, `Bound Session is missing: ${target.member.sessionID}`)
      }
      const profile = target.member.desiredProfile
      if (!profile) return yield* fail(target, "Managed worker has no desired execution profile.")
      // A legacy profile value this runtime cannot map onto the closed
      // ModelRequirement vocabulary is not permission to run anyway. Refusing
      // here is the fail-closed half of the compatibility boundary: honoring it
      // as a requirement would strand the member forever, dropping it would
      // silently weaken a real historical constraint.
      const unproven = target.member.capabilities?.legacyUnprovenRequirements ?? []
      if (unproven.length > 0) {
        return yield* fail(
          target,
          `Stored execution profile carries unprovable legacy requirements (${unproven.join("; ")}). Reconfigure this member's model requirements before materializing it.`,
        )
      }
      const resolved = yield* resolveDirectory(target)
      yield* validateProfile(target, resolved.directory, profile)
      return yield* createAndBind(target, profile, resolved.directory, resolved.reusedWorktree)
    })

    const materialize = Effect.fn("SwarmMemberSession.materialize")(function* (input: {
      readonly swarmID: SwarmModel.ID
      readonly memberID: SwarmModel.MemberID
    }) {
      const target = yield* swarms.memberSessionTarget(input.swarmID, input.memberID)
      return yield* materializeTarget(target)
    })

    const inactiveCandidate = (target: SwarmV2.MemberSessionTarget) => {
      // stop() invalidates authority by incrementing binding_generation. If a
      // provisioning attempt lost that race, its "next" candidate is therefore
      // the now-current generation. held/stopping or a non-active Swarm do not
      // advance the member fence, so the candidate remains generation+1.
      const generation = target.member.lifecycle === "stopped"
        ? target.member.bindingGeneration
        : target.member.bindingGeneration + 1
      return sessionIDForBinding(target.member.id, generation)
    }

    const reconcile = Effect.fn("SwarmMemberSession.reconcile")(function* (input?: {
      readonly projectID?: SwarmModel.Info["projectID"]
      readonly swarmID?: SwarmModel.ID
    }) {
      const targets = yield* swarms.unboundManagedMemberTargets(input)
      const results = yield* Effect.forEach(
        targets,
        (target) =>
          Effect.gen(function* () {
            if (target.swarm.status === "active" && target.member.lifecycle === "active") {
              const outcome = yield* materializeTarget(target).pipe(Effect.exit)
              if (Exit.isSuccess(outcome)) return { type: outcome.value.status, memberID: target.member.id } as const
              const reason = Cause.prettyErrors(outcome.cause)
                .map((error) => error instanceof Error ? error.message : String(error))
                .join("; ")
              return {
                type: "failed" as const,
                memberID: target.member.id,
                reason: reason || "materialization failed",
              }
            }
            const cleaned = yield* cleanupCandidate(inactiveCandidate(target))
            return { type: cleaned, memberID: target.member.id } as const
          }),
        { concurrency: MATERIALIZE_CONCURRENCY },
      )
      return {
        scanned: targets.length,
        bound: results.filter((item) => item.type === "bound").length,
        alreadyBound: results.filter((item) => item.type === "already_bound").length,
        cleaned: results.filter((item) => item.type === "cleaned").length,
        preserved: results.filter((item) => item.type === "preserved").length,
        failed: results.flatMap((item) =>
          item.type === "failed" ? [{ memberID: item.memberID, reason: item.reason }] : [],
        ),
      } satisfies ReconcileResult
    })

    return Service.of({ materialize, reconcile })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    SwarmV2.node,
    SessionStore.node,
    SessionExecutionBoundary.node,
    Database.node,
    InstanceStore.node,
    FSUtil.node,
    SwarmProfilePreflight.node,
    Session.node,
    Worktree.node,
    Git.node,
  ],
})
