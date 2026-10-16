export * as EffectiveContextCompiler from "./compiler"

import { SessionV1 } from "@opencode-ai/core/v1/session"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { SessionTurnProvenance as SharedTurnProvenance } from "@opencode-ai/schema/session-turn-provenance"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { SessionContextStateTable } from "@opencode-ai/core/session/sql"
import { Database } from "@opencode-ai/core/database/database"
import { eq } from "drizzle-orm"
import { Effect } from "effect"

type StateMap = Map<string, { excluded: boolean; pinned: boolean; overrideData?: Record<string, unknown> }>

type OverlayRow = {
  messageID: string
  excluded: boolean
  pinned: boolean
  overrideData: Record<string, unknown> | null
}

// Cache belongs to the exact WAL reader handle, never to the application
// singleton or an Instance. PRAGMA data_version changes when a DIFFERENT
// connection commits; this is only usable when readDb !== db. In-memory
// aliases must always read the table, because their own writes do not advance
// data_version. Capped size/age prevents idle Sessions retaining large edits.
const overlayCache = new WeakMap<object, {
  version: number
  entries: Map<string, { rows: readonly OverlayRow[]; cachedAt: number }>
  lastVersionChangeAt: number
  consecutiveChanges: number
  bypassUntil: number
  directSessions: Set<string>
}>()
const MAX_CACHED_SESSIONS = 64
const MAX_CACHED_ROWS = 64
const MAX_CACHED_ROW_BYTES = 128 * 1024
const MAX_CACHE_AGE_MS = 60_000
// Under a write storm, every data_version check and cache miss adds a second
// reader query. Temporarily prefer the single canonical SELECT until writes
// settle; this NEVER reuses stale data while the cache is bypassed.
const CACHE_CHURN_WINDOW_MS = 1_000
const CACHE_CHURN_BYPASS_MS = 300
const MIN_CACHED_ROWS = 4

// ── Validation & Safety ───────────────────────────────────────────

function hasSignedReasoning(msg: WithParts): boolean {
  return msg.parts.some((p) => p.type === "reasoning" && (p as any).metadata?.anthropic?.signature != null)
}

function hasSignedReasoningInMessage(msg: WithParts): boolean {
  return hasSignedReasoning(msg)
}

export function canEditMessage(msg: WithParts): { allowed: boolean; reason?: string } {
  if (SessionTurnProvenance.hasStateSemanticsTurn(msg)) {
    return { allowed: false, reason: "Replaceable host state is owned by its authoritative domain and cannot be edited" }
  }
  if (hasSignedReasoningInMessage(msg)) {
    return { allowed: false, reason: "Message contains signed reasoning — editing would invalidate provider signature" }
  }
  return { allowed: true }
}

export function canExcludeMessage(msg: WithParts): { allowed: boolean; reason?: string } {
  if (SessionTurnProvenance.hasStateSemanticsTurn(msg)) {
    return { allowed: false, reason: "Replaceable host state is owned by its authoritative domain and cannot be excluded" }
  }
  if (hasSignedReasoningInMessage(msg)) {
    return { allowed: false, reason: "Message contains signed reasoning — excluding would shift signature positions" }
  }
  return { allowed: true }
}

export function canApplyContextOperation(
  msg: WithParts,
  type: string,
): { allowed: boolean; reason?: string } {
  return canApplyContextOperationFacts(msg.info, hasSignedReasoningInMessage(msg), type)
}

/**
 * Pure admission policy over exactly the message facts its guards inspect.
 * A DB-backed bulk probe and a fully hydrated message must yield identical
 * decisions; neither transport may silently implement a weaker policy.
 */
export function canApplyContextOperationFacts(
  info: SharedTurnProvenance.InfoLike,
  signedReasoning: boolean,
  type: string,
): { allowed: boolean; reason?: string } {
  // Restorative operations remain allowed so old/bad overlay rows can be
  // cleared. New mutations against authoritative STATE are never admissible.
  if (
    SessionTurnProvenance.hasStateSemanticsInfo(info) &&
    (type === "message.exclude" || type === "message.pin" || type === "text.replace" || type === "tool.collapse")
  ) {
    return {
      allowed: false,
      reason: "Replaceable host state is owned by its authoritative domain and cannot be mutated by context overlays",
    }
  }
  if (signedReasoning && type === "message.exclude")
    return { allowed: false, reason: "Message contains signed reasoning — excluding would shift signature positions" }
  if (signedReasoning && type === "text.replace")
    return { allowed: false, reason: "Message contains signed reasoning — editing would invalidate provider signature" }
  return { allowed: true }
}

/**
 * Validate the actual mutation target, not just that the part belongs to its
 * message. A text replacement against a tool-only message or collapsing a
 * pending tool would otherwise be durably published as a no-op.
 *
 * Restorative text operations intentionally remain permissive for legacy
 * overlays: they must be able to clear a stale edit even when the original
 * part taxonomy has since changed.
 */
export function canApplyContextOperationTargetFacts(
  type: string,
  partID: string | undefined,
  hasEditablePart: boolean,
  target?: { type: string; status?: string },
): { allowed: boolean; reason?: string } {
  if (type === "text.replace") {
    if (partID && target?.type !== "text" && target?.type !== "reasoning")
      return { allowed: false, reason: "Text replacement requires a text or reasoning part" }
    if (!hasEditablePart)
      return { allowed: false, reason: "Message has no editable text or reasoning parts" }
  }
  if (type === "tool.collapse" && (target?.type !== "tool" || target.status !== "completed"))
    return { allowed: false, reason: "Tool collapse requires a completed tool part" }
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

    // Domain-owned STATE is a materialized projection of current authoritative
    // meaning, not user-editable transcript history. Applying a historical
    // exclude/edit/pin overlay to the newest snapshot could expose an older
    // snapshot and silently resurrect stale state. Ignore overlays completely;
    // the Goal/domain reconciler is the only writer of these bytes.
    if (SessionTurnProvenance.hasStateSemanticsTurn(msg)) {
      if (s?.excluded || s?.pinned || s?.overrideData) {
        warnings.push(`Ignored context overlay for authoritative state projection ${msg.info.id}`)
      }
      effective.push(msg)
      continue
    }

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
  // Context compilation is a committed-state read, not part of the foreground
  // writer transaction. At high Session concurrency, using the primary SQLite
  // handle serializes every provider iteration behind unrelated writes. The
  // dedicated WAL reader has its own admission queue and observes committed
  // overlays without creating a workspace Instance or duplicating state.
  const { db, readDb, filename } = yield* Database.Service
  const cacheEligible = readDb !== db && filename !== ":memory:"
  const now = performance.now()
  let cache = cacheEligible ? overlayCache.get(readDb) : undefined
  // Most Sessions have no conversation-control overrides. One small indexed
  // SELECT is cheaper than PRAGMA + a SELECT and avoids a churn penalty.
  // Direct-read Sessions ALWAYS query the real table, so inserts/edits are
  // visible immediately and no invalidation callback is required.
  const directRead = cache?.directSessions.has(input.sessionID) === true
  // Cross-process and cross-connection invalidation uses SQLite's durable
  // change indicator. Never infer freshness from wall-clock TTL alone.
  // If writes are saturating this reader, skip the extra PRAGMA and always
  // read the canonical overlay row directly until the short cooldown ends.
  const versionRow = cacheEligible && !directRead && (!cache || now >= cache.bypassUntil)
    ? yield* readDb.get<{ data_version: number }>("PRAGMA data_version").pipe(Effect.orDie)
    : undefined
  const version = versionRow?.data_version
  if (version !== undefined && Number.isSafeInteger(version)) {
    if (!cache) {
      cache = {
        version,
        entries: new Map(),
        lastVersionChangeAt: now,
        consecutiveChanges: 0,
        bypassUntil: 0,
        directSessions: new Set(),
      }
      overlayCache.set(readDb, cache)
    } else if (cache.version !== version) {
      cache.entries.clear()
      cache.consecutiveChanges = now - cache.lastVersionChangeAt < CACHE_CHURN_WINDOW_MS
        ? cache.consecutiveChanges + 1
        : 1
      cache.lastVersionChangeAt = now
      cache.version = version
      if (cache.consecutiveChanges >= 3) {
        cache.bypassUntil = now + CACHE_CHURN_BYPASS_MS
        cache.consecutiveChanges = 0
      }
    }
  }
  const cacheAllowed = cache !== undefined && cache.version === version && now >= cache.bypassUntil
  const reused = cacheAllowed ? cache?.entries.get(input.sessionID) : undefined
  let rows: readonly OverlayRow[]
  if (reused && now - reused.cachedAt <= MAX_CACHE_AGE_MS) {
    // Refresh only the LRU position, not the freshness deadline.
    cache!.entries.delete(input.sessionID)
    cache!.entries.set(input.sessionID, reused)
    rows = reused.rows
  } else {
    rows = yield* readDb
      // Large duplicate override_search_text and timestamps are irrelevant to
      // provider compilation; avoid hydrating them across Session streams.
      .select({
        messageID: SessionContextStateTable.message_id,
        excluded: SessionContextStateTable.excluded,
        pinned: SessionContextStateTable.pinned,
        overrideData: SessionContextStateTable.override_data,
      })
      .from(SessionContextStateTable)
      .where(eq(SessionContextStateTable.session_id, input.sessionID as any))
      .all()
      .pipe(Effect.orDie)
    if (cacheEligible && cache && rows.length < MIN_CACHED_ROWS) {
      cache.entries.delete(input.sessionID)
      cache.directSessions.delete(input.sessionID)
      cache.directSessions.add(input.sessionID)
      while (cache.directSessions.size > MAX_CACHED_SESSIONS * 2) {
        cache.directSessions.delete(cache.directSessions.values().next().value!)
      }
    } else if (directRead && rows.length >= MIN_CACHED_ROWS) {
      // Next invocation may try to cache, but only AFTER reading a fresh
      // data_version followed by the canonical SELECT (never tag an older
      // SELECT with a later version).
      cache?.directSessions.delete(input.sessionID)
    }
    if (cacheAllowed && rows.length >= MIN_CACHED_ROWS && rows.length <= MAX_CACHED_ROWS) {
      // Bound retained payloads, not just Session/row count.
      let bytes = 0
      for (const row of rows) {
        bytes += row.messageID.length * 2 + 32
        if (row.overrideData) bytes += JSON.stringify(row.overrideData).length * 2
        if (bytes > MAX_CACHED_ROW_BYTES) break
      }
      if (bytes <= MAX_CACHED_ROW_BYTES) {
        cache!.entries.delete(input.sessionID)
        cache!.entries.set(input.sessionID, { rows, cachedAt: now })
        while (cache!.entries.size > MAX_CACHED_SESSIONS) {
          cache!.entries.delete(cache!.entries.keys().next().value!)
        }
      }
    }
  }

  // The overwhelming common case has no Conversation Control overlays.
  // Preserve the historical shallow-copy contract but skip N per-message
  // provenance/edit checks on every tool/provider iteration.
  if (rows.length === 0) {
    // Canonical history is untouched. Its existing provider-lowering path
    // remains responsible for tool-pair normalization; rescanning every
    // assistant/tool part solely to fall back to these identical messages
    // wastes O(history length) per provider iteration.
    return { effective: input.messages.slice(), excluded: [], pinned: [], warnings: [], hadOverlays: false }
  }

  const state: StateMap = new Map(
    rows.map((r) => [
      r.messageID,
      {
        excluded: r.excluded,
        pinned: r.pinned,
        overrideData: (r.overrideData as Record<string, unknown>) ?? undefined,
      },
    ]),
  )
  return { ...compile({ messages: input.messages, state }), hadOverlays: true }
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
    // Structural conversation atom: assistants parent to V1 role=user ids,
    // including host-owned synthetic turns. Do not replace this with semantic
    // user ownership; provenance is used by human-attribution consumers.
    if (msg.info.role === "user" && !SessionTurnProvenance.hasStateSemanticsInfo(msg.info)) {
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
