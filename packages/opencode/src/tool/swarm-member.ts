import { Effect, Schema } from "effect"
import { SessionV2 } from "@opencode-ai/core/session"
import { SwarmV2 } from "@opencode-ai/core/swarm"
import { SwarmRender } from "@opencode-ai/core/swarm/render"
import { Swarm as SwarmModel } from "@opencode-ai/schema/swarm"
import { InstanceState } from "@/effect/instance-state"
import * as Tool from "./tool"
import DESCRIPTION from "./swarm-member.txt"

/**
 * Managed-worker Swarm facade.
 *
 * This tool exists to remove lifecycle machinery from the model. Every intent
 * resolves Swarm, member, and current task from the trusted caller Session plus
 * durable Swarm state; there is deliberately no `swarmId`, `memberId`, `taskId`,
 * lease token, generation, or run parameter in the schema.
 *
 * Authority rules:
 * - membership comes from `SwarmV2.membersForSession` and is re-checked
 *   against the current project, so a cross-project binding is never usable;
 * - settlement goes through `SwarmV2.sessionTaskAuthority`, which only resolves
 *   an active running run held by this exact Session binding. Admitted-only,
 *   human-held, retiring, superseded, and rebound authority stay un-settleable
 *   here — the facade never re-derives or widens it;
 * - reads stay readable for stopped members so a worker can diagnose why it
 *   cannot act, while every mutating intent requires an active member.
 */
const MEMBER_ACTIONS = [
  "status",
  "done",
  "fail",
  "send",
  "inbox",
  "shared.get",
  "shared.put",
  "publish",
] as const

const LEAF_PERMISSION: Record<(typeof MEMBER_ACTIONS)[number], string> = {
  status: "swarm.read",
  done: "swarm.task",
  fail: "swarm.task",
  send: "swarm.message",
  inbox: "swarm.read",
  "shared.get": "swarm.read",
  "shared.put": "swarm.memory",
  publish: "swarm.review",
}

/** Intents that mutate Swarm state and therefore require an active member. */
const MUTATING: ReadonlySet<(typeof MEMBER_ACTIONS)[number]> = new Set([
  "done",
  "fail",
  "send",
  "shared.put",
  "publish",
])

const MEMBER_SETTLEMENT_FAILURES = [
  "semantic",
  "provider",
  "tool",
  "permission",
  "timeout",
  "session_aborted",
  "internal",
] as const

export const Parameters = Schema.Struct({
  action: Schema.Literals([...MEMBER_ACTIONS]).annotate({
    description:
      "status=current assignment; done=task completed; fail=task failed; send=peer mail; inbox=read peer mail; shared.get/shared.put=shared working state; publish=record deliverable.",
  }),
  swarmName: Schema.optional(Schema.String).annotate({
    description: "Only needed when this Session belongs to more than one Swarm.",
  }),
  summary: Schema.optional(Schema.String).annotate({
    description: "done: what was accomplished. publish: deliverable summary.",
  }),
  failureKind: Schema.optional(Schema.Literals(MEMBER_SETTLEMENT_FAILURES)).annotate({
    description: "fail only: typed failure category.",
  }),
  detail: Schema.optional(Schema.String).annotate({ description: "fail only: concise failure detail." }),
  to: Schema.optional(Schema.String).annotate({
    description: "send only: peer member roster name, or 'all' to broadcast.",
  }),
  kind: Schema.optional(SwarmModel.MessageKind).annotate({ description: "send only: message kind." }),
  priority: Schema.optional(SwarmModel.MessagePriority).annotate({ description: "send only: message priority." }),
  body: Schema.optional(Schema.String).annotate({ description: "send only: message body." }),
  replyExpected: Schema.optional(Schema.Boolean).annotate({ description: "send only: reply contract." }),
  key: Schema.optional(Schema.String).annotate({ description: "shared.get/shared.put: shared-state key." }),
  value: Schema.optional(Schema.Json).annotate({ description: "shared.put: JSON value." }),
  contentType: Schema.optional(Schema.String).annotate({ description: "shared.put: content type." }),
  expectedVersion: Schema.optional(Schema.Int).annotate({
    description: "shared.put: compare-and-set version. Required when overwriting an existing key.",
  }),
  refs: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "publish: evidence references." }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "publish: file path references. Paths are not durable artifacts.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))).annotate({
    description:
      "inbox: how many delivered messages to return (default 20). shared.get without a key: how many shared-state entries to page (default 50).",
  }),
})

type Params = Schema.Schema.Type<typeof Parameters>
type Metadata = {
  action: Params["action"]
  permission: string
  swarmId?: string
  memberId?: string
  taskId?: string
  count?: number
  status?: string
}

interface Membership {
  readonly swarm: SwarmModel.Info
  readonly member: SwarmModel.Member
}

function required(value: string | undefined, name: string) {
  const normalized = value?.trim()
  if (!normalized) throw new Error(`${name} is required`)
  return normalized
}

function fenced(label: string, value: unknown) {
  return [`[SWARM ${label}]`, SwarmRender.fence(JSON.stringify(value, null, 2))].join("\n")
}

function result(
  action: Params["action"],
  permission: string,
  title: string,
  output: string,
  metadata: Omit<Metadata, "action" | "permission"> = {},
) {
  return { title, output, metadata: { action, permission, ...metadata } satisfies Metadata }
}

/**
 * Translate a missing-Authority conflict into an actionable model-facing
 * message instead of a raw domain defect. The important part is that this
 * never downgrades the fence: an un-settleable task stays un-settleable, the
 * worker is simply told why retrying will not help.
 */
function settlementRefusal(reason: string) {
  return new Error(
    `${reason} Call swarm_member status to see your current assignment, then report this instead of retrying settlement.`,
  )
}

export const SwarmMemberTool = Tool.define<typeof Parameters, Metadata, SwarmV2.Service>(
  "swarm_member",
  Effect.gen(function* () {
    const swarms = yield* SwarmV2.Service

    /**
     * Resolve the caller's Swarm/member binding from the caller Session only.
     * Model input may narrow an ambiguous multi-Swarm membership by roster name,
     * but can never name the binding itself.
     */
    const resolve = Effect.fn("SwarmMemberTool.resolve")(function* (ctx: Tool.Context<Metadata>, hint: string | undefined) {
      const instance = yield* InstanceState.context
      const bound = yield* swarms.membersForSession(SessionV2.ID.make(ctx.sessionID))
      const candidates: Membership[] = []
      for (const member of bound) {
        const swarm = yield* swarms.info(member.swarmID)
        // A binding recorded against another project is never usable here.
        if (swarm.projectID !== instance.project.id) continue
        candidates.push({ swarm, member })
      }
      if (candidates.length === 0)
        throw new Error(
          "This Session is not a Swarm member in the current project. Do not fabricate Swarm, member, or task identity; report that you are not assigned.",
        )
      if (candidates.length > 1) {
        const names = candidates.map((candidate) => candidate.swarm.name).sort()
        const wanted = hint?.trim().toLowerCase()
        if (!wanted)
          throw new Error(`This Session is a member of multiple Swarms (${names.join(", ")}). Pass swarmName to choose one.`)
        const picked = candidates.filter((candidate) => candidate.swarm.name.toLowerCase() === wanted)
        if (picked.length !== 1) throw new Error(`swarmName must be exactly one of: ${names.join(", ")}.`)
        return picked[0]!
      }
      if (hint !== undefined && candidates[0]!.swarm.name.toLowerCase() !== hint.trim().toLowerCase())
        throw new Error(`swarmName must be exactly one of: ${candidates[0]!.swarm.name}.`)
      return candidates[0]!
    })

    const ask = Effect.fn("SwarmMemberTool.ask")(function* (
      params: Params,
      membership: Membership,
      ctx: Tool.Context<Metadata>,
    ) {
      const permission = LEAF_PERMISSION[params.action]
      const resource = `swarm:${membership.swarm.id}`
      yield* ctx.ask({ permission, patterns: [resource], always: [resource], metadata: { action: params.action, resource } })
      return permission
    })

    const execute = Effect.fn("SwarmMemberTool.execute")(function* (params: Params, ctx: Tool.Context<Metadata>) {
      const found = yield* resolve(ctx, params.swarmName)
      const permission = yield* ask(params, found, ctx)

      // Only state-changing intents need a live member. Reads stay available to a
      // held/stopped member so it can report *why* it cannot act instead of
      // meeting an opaque denial.
      if (MUTATING.has(params.action) && found.member.lifecycle !== "active")
        throw new Error(
          `Member ${found.member.name} is ${found.member.lifecycle} and cannot mutate Swarm state. Use status to report this.`,
        )

      if (params.action === "status") {
        const summary = yield* swarms.summary(found.swarm.id)
        const authority = yield* swarms
          .sessionTaskAuthority({ swarmID: found.swarm.id, sessionID: SessionV2.ID.make(ctx.sessionID) })
          .pipe(Effect.option)
        const inbox = yield* swarms.memberInbox({
          swarmID: found.swarm.id,
          memberID: found.member.id,
          limit: params.limit ?? 20,
        })
        const task =
          authority._tag === "Some"
            ? {
                id: authority.value.task.id,
                title: authority.value.task.title,
                status: authority.value.task.status,
                runID: authority.value.run.id,
                leaseGeneration: authority.value.token.generation,
              }
            : null
        return result(
          params.action,
          permission,
          `${found.swarm.name} / ${found.member.name}`,
          fenced("STATUS", {
            swarm: {
              name: found.swarm.name,
              status: found.swarm.status,
              role: found.member.role,
              lifecycle: found.member.lifecycle,
              workingTasks: summary.workingTaskCount,
              readyTasks: summary.readyTaskCount,
              pendingDeliveries: summary.pendingDeliveryCount,
            },
            member: { name: found.member.name, role: found.member.role, lifecycle: found.member.lifecycle },
            task,
            taskAuthority:
              task === null
                ? "absent: this Session holds no active running task run. An assignment may still be admitted (not yet executing), held by a human, retiring, or bound to a superseded/rebound Session."
                : "running",
            inbox: inbox.length,
          }),
          { swarmId: found.swarm.id, memberId: found.member.id, status: found.member.lifecycle },
        )
      }

      if (params.action === "done" || params.action === "fail") {
        const authority = yield* swarms
          .sessionTaskAuthority({ swarmID: found.swarm.id, sessionID: SessionV2.ID.make(ctx.sessionID) })
          .pipe(
            Effect.catchTag("Swarm.ConflictError", (error) =>
              Effect.fail(settlementRefusal(`Cannot settle this task: ${error.reason}`)),
            ),
          )
        const failureKind = params.failureKind
        if (params.action === "fail" && failureKind === undefined)
          throw new Error("failureKind is required for fail")
        const settlement =
          params.action === "done"
            ? ({
                type: "completed",
                ...(params.summary === undefined ? {} : { summary: params.summary }),
              } as const)
            : ({
                type: "failed",
                failureKind: failureKind!,
                ...(params.detail === undefined ? {} : { detail: params.detail }),
              } as const)
        const settled = yield* swarms.settleTask({
          token: authority.token,
          runID: authority.run.id,
          settlement,
        })
        return result(
          params.action,
          permission,
          `Task ${settled.task.status}`,
          fenced("TASK SETTLEMENT", {
            task: { id: settled.task.id, title: settled.task.title, status: settled.task.status },
            ...(settled.run === undefined ? {} : { run: { id: settled.run.id, status: settled.run.status } }),
            ...(params.summary === undefined ? {} : { summary: params.summary }),
          }),
          { swarmId: found.swarm.id, memberId: authority.member.id, taskId: settled.task.id, status: settled.task.status },
        )
      }

      if (params.action === "send") {
        const target = required(params.to, "to")
        const detail = yield* swarms.get(found.swarm.id)
        const broadcast = target.toLowerCase() === "all"
        const recipient = broadcast
          ? undefined
          : detail.members.find((member) => member.name.toLowerCase() === target.toLowerCase())
        if (!broadcast && !recipient)
          throw new Error(
            `to must be 'all' or an existing member name of Swarm ${found.swarm.name}: ${detail.members.map((member) => member.name).sort().join(", ")}.`,
          )
        const sent = yield* swarms.enqueueMessage({
          swarmID: found.swarm.id,
          senderMemberID: found.member.id,
          target: broadcast ? { type: "broadcast" } : { type: "member", memberID: recipient!.id },
          kind: params.kind ?? "message",
          body: required(params.body, "body"),
          priority: params.priority,
          replyExpected: params.replyExpected,
        })
        return result(
          params.action,
          permission,
          `Sent ${sent.message.kind}`,
          [SwarmRender.peer(sent.message), fenced("DELIVERIES", sent.deliveries)].join("\n\n"),
          { swarmId: found.swarm.id, memberId: found.member.id, count: sent.deliveries.length },
        )
      }

      if (params.action === "inbox") {
        const rows = yield* swarms.memberInbox({
          swarmID: found.swarm.id,
          memberID: found.member.id,
          limit: params.limit ?? 20,
        })
        const output =
          rows.length === 0
            ? "[SWARM INBOX]\n(no mail addressed to you)"
            : [
                "[SWARM INBOX]",
                ...rows.map(
                  (row) =>
                    `${SwarmRender.peer(row.message)}\nDelivery: ${row.delivery.state} attempts=${row.delivery.attemptCount}${
                      row.delivery.claimOwner ? ` owner=${row.delivery.claimOwner}` : ""
                    }`,
                ),
              ].join("\n\n")
        return result(params.action, permission, `Inbox (${rows.length})`, output, {
          swarmId: found.swarm.id,
          memberId: found.member.id,
          count: rows.length,
        })
      }

      if (params.action === "shared.get") {
        if (params.key !== undefined) {
          const rows = yield* swarms.blackboard({ swarmID: found.swarm.id, key: params.key })
          return result(params.action, permission, `Shared ${params.key}`, fenced("SHARED", rows), {
            swarmId: found.swarm.id,
            count: rows.length,
          })
        }
        // Shared working state is unbounded durable state, so a keyless read must
        // be a bounded page rather than the whole board. Truncation is stated in
        // the result so a worker never mistakes a prefix for the full board.
        const page = yield* swarms.blackboardPage({ swarmID: found.swarm.id, limit: params.limit ?? 50 })
        return result(
          params.action,
          permission,
          `Shared state (${page.items.length})`,
          fenced("SHARED", {
            entries: page.items,
            truncated: page.more,
            ...(page.more
              ? {
                  nextKey: page.nextKey,
                  note: "More keys exist after this page. Read one specific key here, or ask the coordinator for a full listing.",
                }
              : {}),
          }),
          { swarmId: found.swarm.id, count: page.items.length },
        )
      }

      if (params.action === "shared.put") {
        if (params.value === undefined) throw new Error("value is required for shared.put")
        const entry = yield* swarms.putBlackboard({
          swarmID: found.swarm.id,
          key: required(params.key, "key"),
          value: params.value,
          contentType: params.contentType?.trim() || "application/json",
          authorMemberID: found.member.id,
          ...(params.expectedVersion === undefined ? {} : { expectedVersion: params.expectedVersion }),
        })
        return result(params.action, permission, `Shared ${entry.key} v${entry.version}`, fenced("SHARED", entry), {
          swarmId: found.swarm.id,
          memberId: found.member.id,
        })
      }

      // publish
      const authority = yield* swarms
        .sessionTaskAuthority({ swarmID: found.swarm.id, sessionID: SessionV2.ID.make(ctx.sessionID) })
        .pipe(Effect.option)
      const deliverable = yield* swarms.publishDeliverable({
        swarmID: found.swarm.id,
        memberID: found.member.id,
        ...(authority._tag === "Some" ? { taskRunID: authority.value.run.id } : {}),
        summary: required(params.summary, "summary"),
        refs: params.refs ?? [],
        files: params.files ?? [],
      })
      return result(params.action, permission, "Published deliverable", fenced("DELIVERABLE", deliverable), {
        swarmId: found.swarm.id,
        memberId: found.member.id,
      })
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params, ctx) => execute(params, ctx).pipe(Effect.orDie),
    }
  }),
)
