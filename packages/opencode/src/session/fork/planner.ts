export * as ForkPlanner from "./planner"

import { Effect, Option } from "effect"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { MessageV2 } from "../message-v2"
import { Database } from "@opencode-ai/core/database/database"
import { SessionContextState } from "../context/state"
import { EffectiveContextCompiler } from "../context/compiler"

export interface ForkBoundary {
  messageID?: string
  edge: "before" | "after"
}

export interface ForkPlan {
  sourceSessionID: string
  boundary: ForkBoundary
  boundaryIndex: number // number of canonical messages to include
  messages: WithParts[] // canonical slice
  effectiveMessages: WithParts[] // after applying context state
  composerRestore?: string // text to restore if forking before a user message
  hasSignedReasoning: boolean
  warnings: string[]
}

function isCompletedAssistant(msg: WithParts): boolean {
  if (msg.info.role !== "assistant") return false
  const a = msg.info as SessionV1.Assistant
  return !!a.time.completed || !!a.error
}

function findLastCompletedIndex(messages: WithParts[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (!msg) continue
    if (msg.info.role === "user") return i + 1 // user messages are always completed
    if (isCompletedAssistant(msg)) return i + 1
  }
  return messages.length
}

/**
 * Plans a fork operation, resolving boundary, snapping to completed turns,
 * applying effective-context inheritance, and validating the result.
 */
export const plan = Effect.fn("ForkPlanner.plan")(function* (input: {
  sourceSessionID: string
  boundary?: ForkBoundary
}) {
  const allMessages = yield* MessageV2.stream(input.sourceSessionID as any).pipe(
    Effect.provideService(Database.Service, (yield* Database.Service) as any),
  )

  // Need full messages with parts — use Session.messages pagination instead of MessageV2.stream?
  // MessageV2.stream already hydrates parts, so it's complete.
  // But to respect Database layer, we fetch via MessageV2.stream with proper service.

  // Actually MessageV2.stream needs Database.Service — handled above.
  const messages: WithParts[] = (allMessages as WithParts[]) ?? []

  // Resolve boundary
  let boundaryIndex: number
  let composerRestore: string | undefined
  const warnings: string[] = []

  if (!input.boundary?.messageID) {
    // Fork from end — include everything through last completed turn
    const lastCompleted = findLastCompletedIndex(messages)
    if (lastCompleted < messages.length) {
      warnings.push(`Fork snapped to last completed turn (${lastCompleted}/${messages.length} messages) — streaming turn excluded`)
    }
    boundaryIndex = lastCompleted
  } else {
    const idx = messages.findIndex((m) => m.info.id === input.boundary!.messageID)
    if (idx === -1) {
      return yield* Effect.fail(new Error(`Boundary message not found: ${input.boundary.messageID}`))
    }
    const target = messages[idx]!
    if (target.info.role === "assistant" && !isCompletedAssistant(target)) {
      // Snap backward to last completed turn
      const lastCompleted = findLastCompletedIndex(messages.slice(0, idx))
      warnings.push(`Boundary assistant message is streaming — snapped to last completed turn`)
      boundaryIndex = lastCompleted
    } else {
      boundaryIndex = input.boundary.edge === "before" ? idx : idx + 1
    }

    // Composer restore for edge=before on user messages
    if (input.boundary.edge === "before" && target.info.role === "user") {
      const textPart = target.parts.find((p) => p.type === "text") as SessionV1.TextPart | undefined
      if (textPart?.text) composerRestore = textPart.text
      // Also collect file parts for restoration (handled by caller via message.parts)
    }
  }

  const canonicalSlice = messages.slice(0, boundaryIndex)

  // Apply effective context state: respect exclusions/edits
  const stateMap = yield* SessionContextState.getState(input.sourceSessionID as any).pipe(
    Effect.catch(() => Effect.succeed(new Map())),
  )
  const compiled = EffectiveContextCompiler.compile({ messages: canonicalSlice, state: stateMap as any })
  warnings.push(...compiled.warnings)

  const hasSignedReasoning = canonicalSlice.some((m) =>
    m.parts.some((p) => p.type === "reasoning" && (p as any).metadata?.anthropic?.signature != null),
  )

  const plan: ForkPlan = {
    sourceSessionID: input.sourceSessionID,
    boundary: input.boundary ?? { edge: "after" },
    boundaryIndex,
    messages: canonicalSlice,
    effectiveMessages: compiled.effective,
    composerRestore,
    hasSignedReasoning,
    warnings,
  }

  // Validate effective history
  const issues = EffectiveContextCompiler.validateEffectiveHistory(plan.effectiveMessages)
  if (issues.length > 0) {
    warnings.push(...issues.map((i) => `Validation: ${i}`))
  }

  return plan
})

export function countTokensForMessages(messages: WithParts[]): number {
  // Rough estimator — matches ledger's estimateMessageTokens but without DB
  let total = 0
  for (const msg of messages) {
    for (const p of msg.parts) {
      if (p.type === "text") total += Math.ceil(((p as any).text as string).length / 4)
      if (p.type === "reasoning") total += Math.ceil(((p as any).text as string).length / 4)
      if (p.type === "tool") {
        const tp = p as SessionV1.ToolPart
        if (tp.state.status === "completed") total += Math.ceil(tp.state.output.length / 4)
      }
    }
  }
  return total
}
