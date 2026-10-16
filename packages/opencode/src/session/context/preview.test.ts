import { describe, expect, test } from "bun:test"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import type { SessionContext } from "@opencode-ai/schema/session-context"
import { EffectiveContextCompiler } from "./compiler"
import { estimateMessageTokens } from "./ledger"
import { projectContextPreview } from "./preview"

function message(id: string, value: string): WithParts {
  return {
    info: { id, role: "user", time: { created: 1 }, agent: "test" },
    parts: [{ id: `prt_${id}`, type: "text", text: value }],
  } as unknown as WithParts
}

function ledger(
  messages: readonly WithParts[],
  state: Map<string, { excluded: boolean; pinned: boolean; overrideData?: Record<string, unknown> }>,
): SessionContext.Ledger {
  const entries = messages.map((msg) => {
    const s = state.get(msg.info.id)
    return {
      messageID: msg.info.id,
      type: "user",
      role: msg.info.role,
      preview: "",
      tokenEstimate: estimateMessageTokens(msg),
      excluded: s?.excluded ?? false,
      pinned: s?.pinned ?? false,
      edited: !!s?.overrideData,
      hasSignedReasoning: false,
      partCount: msg.parts.length,
      timeCreated: 1,
    }
  })
  return {
    sessionID: "ses_preview_test",
    entries,
    totals: {
      messageCount: entries.length,
      excludedCount: entries.filter((item) => item.excluded).length,
      pinnedCount: entries.filter((item) => item.pinned).length,
      editedCount: entries.filter((item) => item.edited).length,
      estimatedTokens: entries.filter((item) => !item.excluded).reduce((sum, item) => sum + item.tokenEstimate, 0),
      estimatedTokensExcluded: entries.filter((item) => item.excluded).reduce((sum, item) => sum + item.tokenEstimate, 0),
    },
  } as unknown as SessionContext.Ledger
}

describe("Context preview domain projection", () => {
  test("rejects mismatched history order instead of silently reporting corrupted totals", () => {
    const messages = [message("msg_preview_alignment_a", "first"), message("msg_preview_alignment_b", "second")]
    const state = new Map()
    const totals = ledger(messages, state)
    const compiled = EffectiveContextCompiler.compile({ messages, state })
    expect(() => projectContextPreview({
      messages, ledger: { ...totals, entries: [...totals.entries].reverse() },
      compiled,
    })).toThrow(/ordering/)
    expect(() => projectContextPreview({
      messages, ledger: totals,
      compiled: { effective: [...compiled.effective].reverse(), excluded: [] },
    })).toThrow(/ordered partition/)
  })

  test("reuses unchanged ledger estimates without losing the role framing overhead", () => {
    const messages = [message("msg_preview_a", "alpha"), message("msg_preview_b", "bravo")]
    const state = new Map()
    const compiled = EffectiveContextCompiler.compile({ messages, state })
    const result = projectContextPreview({ messages, ledger: ledger(messages, state), compiled })
    const total = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0)
    expect(result).toEqual({
      beforeTokens: total, afterTokens: total, removedTokens: 0,
      messageCount: 2, effectiveCount: 2, earliestMutationIndex: undefined,
    })
  })

  test("pinned+excluded wins, real exclusions count once, and transformed text changes the token total", () => {
    const messages = [
      message("msg_preview_pinned", "one"),
      message("msg_preview_edited", "x"),
      message("msg_preview_removed", "removed text"),
    ]
    const state = new Map([
      ["msg_preview_pinned", { excluded: true, pinned: true }],
      ["msg_preview_edited", { excluded: false, pinned: false, overrideData: { text: "a substantially longer replacement" } }],
      ["msg_preview_removed", { excluded: true, pinned: false }],
    ])
    const compiled = EffectiveContextCompiler.compile({ messages, state })
    expect(compiled.effective).toHaveLength(2)
    expect(compiled.effective[0]).toBe(messages[0])
    expect(compiled.effective[1]).not.toBe(messages[1])
    const result = projectContextPreview({ messages, ledger: ledger(messages, state), compiled })
    expect(result).toEqual({
      beforeTokens: messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0),
      afterTokens: estimateMessageTokens(messages[0]!) + estimateMessageTokens(compiled.effective[1]!),
      removedTokens: estimateMessageTokens(messages[2]!),
      messageCount: 3,
      effectiveCount: 2,
      earliestMutationIndex: 0,
    })
  })

  test("does not turn a genuinely empty effective context into a fictitious nonzero total", () => {
    const messages = [message("msg_preview_only", "everything excluded")]
    const state = new Map([["msg_preview_only", { excluded: true, pinned: false }]])
    const compiled = EffectiveContextCompiler.compile({ messages, state })
    expect(compiled.effective).toHaveLength(0)
    const result = projectContextPreview({ messages, ledger: ledger(messages, state), compiled })
    expect(result.afterTokens).toBe(0)
    expect(result.removedTokens).toBe(result.beforeTokens)
    expect(result.effectiveCount).toBe(0)
  })
})
