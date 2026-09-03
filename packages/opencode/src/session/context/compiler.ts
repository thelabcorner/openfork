export * as EffectiveContextCompiler from "./compiler"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { SessionContextStateTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Effect } from "effect"

type StateMap = Map<string, { excluded: boolean; pinned: boolean; overrideData?: Record<string, unknown> }>

// ── Validation & Safety ───────────────────────────────────────────

function hasSignedReasoning(msg: WithParts): boolean {
  return msg.parts.some((p) => p.type === "reasoning" && (p as any).metadata?.anthropic?.signature != null)
}

function hasSignedReasoningInMessage(msg: WithParts): boolean {
  return hasSignedReasoning(msg)
}

export function canEditMessage(msg: WithParts): { allowed: boolean; reason?: string } {
  if (hasSignedReasoningInMessage(msg)) {
    return { allowed: false, reason: "Message contains signed reasoning — editing would invalidate provider signature" }
  }
  return { allowed: true }
}

export function canExcludeMessage(msg: WithParts): { allowed: boolean; reason?: string } {
  if (hasSignedReasoningInMessage(msg)) {
    return { allowed: false, reason: "Message contains signed reasoning — excluding would shift signature positions" }
  }
  return { allowed: true }
}

// ── Core compiler ─────────────────────────────────────────────────

/**
 * Compiles canonical history + context state into effective context.
 *
 * Invariants enforced:
 *  - Excluded messages are dropped entirely (unless pinned — pinned wins)
 *  - Text edits replace the relevant TextPart(s) in-place
 *  - Tool collapse replaces tool output with a stub (reversible)
 *  - Edited reasoning degrades to text (strips providerMetadata)
 *  - Tool pairs are never split — if a tool call is present, its result stays
 *  - Signed-reasoning messages are never edited/excluded (gate above)
 */
export function compile(input: { messages: WithParts[]; state: StateMap }): {
  effective: WithParts[]
  excluded: WithParts[]
  pinned: string[]
  warnings: string[]
} {
  const effective: WithParts[] = []
  const excluded: WithParts[] = []
  const pinned: string[] = []
  const warnings: string[] = []

  for (const msg of input.messages) {
    const s = input.state.get(msg.info.id)

    // Pinned messages are never excluded, even if marked excluded
    if (s?.pinned) pinned.push(msg.info.id)

    if (s?.excluded && !s.pinned) {
      const check = canExcludeMessage(msg)
      if (!check.allowed) {
        warnings.push(`Skipped exclusion of ${msg.info.id}: ${check.reason}`)
        // Fall through — include it despite exclusion flag, with warning
      } else {
        excluded.push(msg)
        continue
      }
    }

    // Apply overrides
    if (s?.overrideData) {
      const override = s.overrideData as any

      // Tool collapse sentinel
      if (override.collapsed && override.partID) {
        // Replace that tool part's output with a truncation stub
        const cloned: WithParts = {
          info: msg.info,
          parts: msg.parts.map((p) => {
            if (p.type === "tool" && p.id === override.partID) {
              const toolPart = p as SessionV1.ToolPart
              if (toolPart.state.status === "completed") {
                return {
                  ...toolPart,
                  state: {
                    ...toolPart.state,
                    output: `[Tool output collapsed — original ${toolPart.state.output.length} chars. Restore to view.]`,
                    time: { ...toolPart.state.time, compacted: Date.now() },
                  },
                }
              }
            }
            return p
          }),
        }
        effective.push(cloned)
        continue
      }

      // Text replace: override.text replaces TextPart(s)
      if (override.text != null) {
        const check = canEditMessage(msg)
        if (!check.allowed) {
          warnings.push(`Skipped edit of ${msg.info.id}: ${check.reason}`)
          effective.push(msg)
          continue
        }

        // If partID specified, replace only that part; otherwise replace first text part
        const targetPartID = override.partID as string | undefined
        let replaced = false
        const cloned: WithParts = {
          info: msg.info,
          parts: msg.parts.map((p) => {
            if (p.type === "text") {
              if (targetPartID && p.id !== targetPartID) return p
              if (!targetPartID && replaced) return p
              replaced = true
              // Strip ignored/synthetic flags that would hide the edit; keep metadata sans provider signature
              const { ignored: _ignored, ...rest } = p as any
              return { ...rest, text: override.text as string }
            }
            if (p.type === "reasoning") {
              // Reasoning edits degrade to text — strip providerMetadata
              // This path is gated by canEditMessage, so signed reasoning won't reach here,
              // but handle it defensively for future callers.
              if (targetPartID && p.id !== targetPartID) return p
              if (p.metadata?.anthropic?.signature) {
                warnings.push(`Stripped providerMetadata from edited reasoning ${p.id}`)
              }
              return { ...p, text: override.text as string, metadata: undefined }
            }
            return p
          }),
        }
        // If no text part was found to replace, append a new one (handles empty assistant msgs)
        if (!replaced && override.text) {
          const { MessageID, PartID } = { MessageID: null, PartID: null }
          void MessageID
          void PartID
          // We can't synthesize IDs without schema imports here; the caller should ensure
          // the message has at least one text part. Fall back to pushing original + warning.
          warnings.push(`No text part found to replace in ${msg.info.id} — edit had no effect`)
        }
        effective.push(cloned)
        continue
      }
    }

    // No transform — pass through
    effective.push(msg)
  }

  return { effective, excluded, pinned, warnings }
}

// ── DB-aware wrapper ──────────────────────────────────────────────

export const compileForSession = Effect.fn("EffectiveContextCompiler.compileForSession")(function* (input: {
  messages: WithParts[]
  sessionID: string
}) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select()
    .from(SessionContextStateTable)
    .where(eq(SessionContextStateTable.session_id, input.sessionID as any))
    .all()
    .pipe(Effect.orDie)

  const state: StateMap = new Map(
    rows.map((r) => [
      r.message_id,
      {
        excluded: r.excluded,
        pinned: r.pinned,
        overrideData: (r.override_data as Record<string, unknown>) ?? undefined,
      },
    ]),
  )
  return compile({ messages: input.messages, state })
})

// ── Turn grouping (Context Atom) ──────────────────────────────────
// Assistant.parentID points at originating user message. This gives exact turn atoms.

export interface TurnAtom {
  user: WithParts
  assistants: WithParts[]
  allParts: SessionV1.Part[]
}

export function groupTurns(messages: WithParts[]): TurnAtom[] {
  const byParent = new Map<string, WithParts[]>()
  const users: WithParts[] = []

  for (const msg of messages) {
    if (msg.info.role === "user") {
      users.push(msg)
    } else if (msg.info.role === "assistant") {
      const parentID = (msg.info as SessionV1.Assistant).parentID
      const list = byParent.get(parentID) ?? []
      list.push(msg)
      byParent.set(parentID, list)
    }
  }

  return users.map((user) => {
    const assistants = byParent.get(user.info.id) ?? []
    return {
      user,
      assistants,
      allParts: [...user.parts, ...assistants.flatMap((a) => a.parts)],
    }
  })
}

export function validateEffectiveHistory(messages: WithParts[]): string[] {
  const issues: string[] = []

  // Check tool pair integrity: every tool call should have been emitted with a result
  // (pending/running are normalized to error in toModelMessagesEffect, so not checked here)
  for (const msg of messages) {
    if (msg.info.role !== "assistant") continue
    for (const p of msg.parts) {
      if (p.type !== "tool") continue
      const toolPart = p as SessionV1.ToolPart
      // Native tool pair validation is done in toModelMessagesEffect; here we just ensure
      // no orphaned tool results without calls (should be impossible via compiler, but check)
      if (!toolPart.callID) issues.push(`Tool part ${toolPart.id} missing callID`)
    }
  }

  // Check no unfinished assistant turn is included (time.completed missing)
  for (const msg of messages) {
    if (msg.info.role === "assistant") {
      const assistant = msg.info as SessionV1.Assistant
      if (!assistant.time.completed && !assistant.error) {
        issues.push(`Unfinished assistant message ${assistant.id} included in effective context`)
      }
    }
  }

  return issues
}
