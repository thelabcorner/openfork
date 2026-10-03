export * as GoalProjection from "./projection"

import { Context, DateTime, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeGlobalNode } from "../effect/app-node"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionMessageProjection } from "../session/message-projection"
import { SessionSchema } from "../session/schema"
import { SessionMessageTable } from "../session/sql"
import { SessionTurnProvenance } from "../session/turn-provenance"
import { Hash } from "../util/hash"
import { Goal } from "./index"

export type Kind = "spec" | "progress"

export interface Section {
  readonly kind: Kind
  readonly source: string
  readonly goalID: Goal.ID
  readonly text: string
  readonly digest: string
  readonly stateIdentity: string
  readonly ref: string
}

export interface EffectiveState {
  readonly resetBoundary?: SessionMessage.ID
  readonly messages: ReadonlyMap<string, SessionMessage.Synthetic>
}

export interface Result {
  readonly focused: boolean
  readonly published: number
}

const REF_PREFIX = "goal-state:v1"

const sourceFor = (kind: Kind) =>
  kind === "spec" ? SessionTurnProvenance.Source.GoalSpecification : SessionTurnProvenance.Source.GoalProgress

function escapeText(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function escapeAttribute(value: string) {
  return escapeText(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;")
}

function optionalAttribute(name: string, value: string | number | undefined) {
  return value === undefined ? "" : ` ${name}="${escapeAttribute(String(value))}"`
}

export function renderSpec(detail: Goal.Detail) {
  return [
    `<goal_spec state="current" goal_id="${escapeAttribute(detail.goal.id)}">`,
    `  <title>${escapeText(detail.goal.title)}</title>`,
    `  <objective>${escapeText(detail.goal.objective)}</objective>`,
    "  <constraints>",
    ...detail.goal.constraints.map((constraint) => `    <constraint>${escapeText(constraint)}</constraint>`),
    "  </constraints>",
    "  <acceptance_criteria>",
    ...detail.criteria.map(
      (criterion) => `    <criterion id="${escapeAttribute(criterion.id)}">${escapeText(criterion.description)}</criterion>`,
    ),
    "  </acceptance_criteria>",
    "  <steps>",
    ...detail.steps.map(
      (step) =>
        `    <step id="${escapeAttribute(step.id)}" title="${escapeAttribute(step.title)}">${escapeText(step.description)}</step>`,
    ),
    "  </steps>",
    "</goal_spec>",
  ].join("\n")
}

export function renderProgress(detail: Goal.Detail) {
  return [
    `<goal_progress state="current" goal_id="${escapeAttribute(detail.goal.id)}">`,
    `  <status>${detail.goal.status}</status>`,
    detail.goal.blocker ? `  <blocker>${escapeText(detail.goal.blocker)}</blocker>` : "  <blocker />",
    "  <criteria>",
    ...detail.criteria.map(
      (criterion) => `    <criterion id="${escapeAttribute(criterion.id)}" status="${criterion.status}" />`,
    ),
    "  </criteria>",
    "  <steps>",
    ...detail.steps.map(
      (step) =>
        `    <step id="${escapeAttribute(step.id)}" status="${step.status}" attempts="${step.attempts}"${optionalAttribute("assigned_session_id", step.assignedSessionID)} />`,
    ),
    "  </steps>",
    "</goal_progress>",
  ].join("\n")
}

export function renderAbsent(kind: Kind, goalID: Goal.ID) {
  return `<goal_${kind} state="none" goal_id="${escapeAttribute(goalID)}" />`
}

export function section(kind: Kind, goalID: Goal.ID, text: string): Section {
  const digest = Hash.sha256(text)
  const stateIdentity = JSON.stringify([goalID, kind, digest])
  return {
    kind,
    source: sourceFor(kind),
    goalID,
    text,
    digest,
    stateIdentity,
    ref: `${REF_PREFIX}:${kind}:${encodeURIComponent(goalID)}:${digest}`,
  }
}

export function sections(detail: Goal.Detail): readonly Section[] {
  return [
    section("spec", detail.goal.id, renderSpec(detail)),
    section("progress", detail.goal.id, renderProgress(detail)),
  ]
}

export function parseRef(source: string, ref: string | undefined) {
  if (!ref) return undefined
  const kind: Kind | undefined =
    source === SessionTurnProvenance.Source.GoalSpecification
      ? "spec"
      : source === SessionTurnProvenance.Source.GoalProgress
        ? "progress"
        : undefined
  if (!kind) return undefined
  const prefix = `${REF_PREFIX}:${kind}:`
  if (!ref.startsWith(prefix)) return undefined
  const rest = ref.slice(prefix.length)
  const split = rest.lastIndexOf(":")
  if (split <= 0) return undefined
  const encodedGoalID = rest.slice(0, split)
  const digest = rest.slice(split + 1)
  if (!/^[0-9a-f]{64}$/.test(digest)) return undefined
  try {
    return { kind, goalID: Goal.ID.make(decodeURIComponent(encodedGoalID)), digest }
  } catch {
    return undefined
  }
}

function hostRef(message: SessionMessage.Synthetic) {
  const provenance = message.provenance
  return provenance?.owner === "host" ? provenance.ref : undefined
}

export function resetBoundary(sessionID: SessionSchema.ID, compaction?: SessionMessage.ID) {
  return compaction ? `session:${sessionID}:compaction:${compaction}` : `session:${sessionID}:root`
}

export function publicationMessageID(input: {
  readonly sessionID: SessionSchema.ID
  readonly section: Section
  readonly resetBoundary?: SessionMessage.ID
  /**
   * Effective projection being superseded in this volatility domain. This is
   * the section-local reset boundary: A -> B -> A must produce a second A row,
   * while an unchanged A remains a no-op. After compaction there is no effective
   * predecessor, so the compaction epoch itself becomes the reset boundary.
   */
  readonly predecessor?: SessionMessage.ID
}) {
  const boundary = input.predecessor
    ? `session:${input.sessionID}:projection:${input.section.kind}:${input.predecessor}`
    : resetBoundary(input.sessionID, input.resetBoundary)
  const identity = JSON.stringify([
    input.section.stateIdentity,
    boundary,
  ])
  return SessionMessage.ID.make(`msg_goal_projection_${Hash.sha256(identity)}`)
}

export interface Interface {
  readonly reconcile: (input: {
    readonly sessionID: SessionSchema.ID
    readonly effective: EffectiveState
  }) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/GoalProjection") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const goals = yield* Goal.Service
    const events = yield* EventV2.Service
    const { db } = yield* Database.Service

    const publish = Effect.fn("GoalProjection.publish")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly effective: EffectiveState
      readonly value: Section
    }) {
      const current = input.effective.messages.get(input.value.source)
      if (current) {
        const currentRef = hostRef(current)
        const parsed = parseRef(input.value.source, currentRef)
        if (!parsed) return yield* Effect.die(`Malformed ${input.value.source} projection provenance: ${current.id}`)
        if (currentRef === input.value.ref) {
          if (current.text !== input.value.text)
            return yield* Effect.die(`Goal projection ${current.id} claims the current semantic digest with different bytes`)
          return false
        }
      }

      const messageID = publicationMessageID({
        sessionID: input.sessionID,
        section: input.value,
        resetBoundary: input.effective.resetBoundary,
        ...(current ? { predecessor: current.id } : {}),
      })
      const provenance = SessionTurnProvenance.host(input.value.source, { ref: input.value.ref })
      const existing = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, messageID))
        .get()
        .pipe(Effect.orDie)
      if (existing) {
        if (existing.session_id !== input.sessionID)
          return yield* Effect.die(`Goal projection message ${messageID} belongs to another Session`)
        const decoded = yield* SessionMessageProjection.decodeRow(db, existing).pipe(Effect.orDie)
        if (
          decoded.type !== "synthetic" ||
          decoded.text !== input.value.text ||
          !SessionTurnProvenance.hasHostCorrelation(decoded, input.value.source, input.value.ref)
        )
          return yield* Effect.die(`Goal projection message ${messageID} conflicts with its deterministic identity`)
        return false
      }

      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        text: input.value.text,
        provenance,
      })
      return true
    })

    const reconcile = Effect.fn("GoalProjection.reconcile")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly effective: EffectiveState
    }) {
      const focused = yield* goals.focused(input.sessionID)
      let desired: readonly Section[]
      if (focused) {
        desired = sections(focused.detail)
      } else {
        desired = (["spec", "progress"] as const).flatMap((kind) => {
          const source = sourceFor(kind)
          const current = input.effective.messages.get(source)
          if (!current) return []
          const parsed = parseRef(source, hostRef(current))
          if (!parsed) throw new Error(`Malformed ${source} projection provenance: ${current.id}`)
          return [section(kind, parsed.goalID, renderAbsent(kind, parsed.goalID))]
        })
      }

      let published = 0
      for (const value of desired) {
        if (yield* publish({ ...input, value })) published++
      }
      return { focused: focused !== undefined, published } satisfies Result
    })

    return Service.of({ reconcile })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Goal.node, EventV2.node, Database.node] })
