import { describe, expect, test } from "bun:test"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import type { WithParts } from "@opencode-ai/schema/session-v1"
import { buildWithRows, estimateMessageTokens, type LedgerOverlayRow } from "./ledger"
import { EffectiveContextCompiler } from "./compiler"

function message(id: string, parts: Record<string, unknown>[], provenance?: Record<string, unknown>): WithParts {
  return {
    info: {
      id, sessionID: "ses_ledger_projection",
      role: "user", time: { created: 1000 },
      ...(provenance ? { provenance } : {}),
    },
    parts: parts.map((p, i) => ({ id: `prt_${id}_${i}`, ...p })),
  } as unknown as WithParts
}
const overlay = (
  id: string,
  data: Partial<Pick<LedgerOverlayRow, "excluded" | "pinned" | "override_data">>,
) => ({
  message_id: id, excluded: false, pinned: false, override_data: null, ...data,
}) as LedgerOverlayRow

describe("Context ledger single-pass materialization", () => {
  test("preserves the original role+part token estimates and preview precedence", () => {
    const parts = [
      { type: "text", text: "" },
      { type: "text", text: "not first" },
      { type: "reasoning", text: "reasoning" },
      { type: "tool", tool: "read", state: { status: "completed", output: "file contents" } },
      { type: "tool", tool: "write", state: { status: "error", error: "failed" } },
      { type: "file", name: "file.txt" },
      { type: "compaction" },
    ]
    const msg = message("msg_ledger_mixed", parts)
    const result = buildWithRows({ sessionID: "ses_ledger_projection", messages: [msg] }, [])
    expect(result.entries[0]).toMatchObject({
      type: "compaction",
      preview: "[tool: read]",
      tokenEstimate: estimateMessageTokens(msg),
      partCount: 7,
      hasSignedReasoning: false,
    })
    const second = message("msg_ledger_second", [{ type: "text", text: "first" }, { type: "text", text: "second" }])
    expect(buildWithRows({ sessionID: "ses_ledger_projection", messages: [second] }, []).entries[0]).toMatchObject({
      preview: "first", tokenEstimate: estimateMessageTokens(second),
    })
  })

  test("counts only effective exclusions: pinned wins and signed reasoning cannot be excluded", () => {
    const pinned = message("msg_ledger_pinned", [{ type: "text", text: "Keep pinned" }])
    const signed = message("msg_ledger_signed", [
      { type: "reasoning", text: "Reason", metadata: { anthropic: { signature: "provider-signed" } } },
    ])
    const excluded = message("msg_ledger_excluded", [{ type: "text", text: "Drop this" }])
    const state = [
      overlay(pinned.info.id, { pinned: true, excluded: true }),
      overlay(signed.info.id, { excluded: true }),
      overlay(excluded.info.id, { excluded: true }),
    ]
    const history = [pinned, signed, excluded]
    const result = buildWithRows({ sessionID: "ses_ledger_projection", messages: history }, state)
    expect(result.entries.map((entry) => entry.excluded)).toEqual([false, false, true])
    expect(result.entries.map((entry) => entry.pinned)).toEqual([true, false, false])
    expect(result.totals.excludedCount).toBe(1)
    expect(result.totals.estimatedTokensExcluded).toBe(estimateMessageTokens(excluded))
    expect(result.entries[1]?.hasSignedReasoning).toBe(true)
    const compiled = EffectiveContextCompiler.compile({
      messages: history, state: new Map(state.map((s) => [
        s.message_id,
        { excluded: s.excluded, pinned: s.pinned },
      ])),
    })
    expect(compiled.excluded.map((item) => item.info.id)).toEqual([excluded.info.id])
  })

  test("does not report no-op stale edits as effective mutations", () => {
    const msg = message("msg_ledger_stale_edit", [
      { type: "text", text: "immutable original" },
      { type: "tool", tool: "read", state: { status: "pending" } },
    ])
    const rows = [
      overlay(msg.info.id, { override_data: { text: "never applied", partID: "prt_missing" } }),
    ]
    expect(buildWithRows({ sessionID: "ses_ledger_projection", messages: [msg] }, rows).entries[0]?.edited).toBe(false)
    rows[0] = overlay(msg.info.id, { override_data: { collapsed: true, partID: `prt_${msg.info.id}_1` } })
    expect(buildWithRows({ sessionID: "ses_ledger_projection", messages: [msg] }, rows).entries[0]?.edited).toBe(false)
    rows[0] = overlay(msg.info.id, { override_data: { text: "new text", partID: `prt_${msg.info.id}_0` } })
    expect(buildWithRows({ sessionID: "ses_ledger_projection", messages: [msg] }, rows).entries[0]?.edited).toBe(true)
  })

  test("ignores forged overlays on authoritative domain STATE projections", () => {
    const msg = message("msg_ledger_protected", [{ type: "text", text: "truth" }],
      SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
        ref: "goal-state:v1:progress:gol_example:" + "a".repeat(64),
      }))
    const result = buildWithRows({
      sessionID: "ses_ledger_projection", messages: [msg],
    }, [overlay(msg.info.id, { pinned: true, excluded: true, override_data: { text: "forgery" } })])
    expect(result.entries[0]).toMatchObject({ excluded: false, edited: false, pinned: false })
    expect(result.totals.estimatedTokens).toBe(estimateMessageTokens(msg))
  })
})
