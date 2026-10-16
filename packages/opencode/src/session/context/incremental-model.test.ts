import { describe, expect, test } from "bun:test"
import { SessionLedger } from "./ledger"
import { contextPartFacts } from "@opencode-ai/core/session/context-part-facts"
import { SessionTurnProvenance } from "@opencode-ai/core/v1/session-turn-provenance"
import {
  addContextMaterializedTotals,
  contextMaterializedDelta,
  materializeContextMessage,
  zeroContextMaterializedTotals,
  type ContextMaterializedTotals,
} from "@opencode-ai/core/session/context-incremental-model"

function random(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296)
}
const pick = <T>(r: () => number, choices: readonly T[]) => choices[Math.floor(r() * choices.length)]!
const letters = "abcdefghijklmnopqrstuvxyz"

describe("transactional Context incremental model: canonical parity", () => {
  test("10,000 randomized message/part/overlay projections equal the existing V1 ledger oracle", () => {
    const rng = random(0x40bc2026)
    for (let i = 0; i < 10_000; i++) {
      const id = `msg_materialized_${i}`
      const sessionID = "ses_model_fuzz"
      const stateOwned = rng() < .1
      const parts = Array.from({ length: Math.floor(rng() * 7) }, (_, j) => {
        const type = pick(rng, ["text", "reasoning", "file", "tool", "step-start"] as const)
        const pid = `prt_materialized_${i}_${j}`
        const text = Array.from({ length: Math.floor(rng() * 99) }, () => pick(rng, letters.split(""))).join("")
        if (type === "text") return { id: pid, sessionID, messageID: id, type, text }
        if (type === "reasoning") return { id: pid, sessionID, messageID: id, type, text,
          ...(rng() < .2 ? { metadata: { anthropic: { signature: "signed" } } } : {}) }
        if (type === "file") return { id: pid, sessionID, messageID: id, type, mime: "image/png", url: "data:", filename: "x" }
        if (type === "tool") {
          const status = pick(rng, ["completed", "error", "pending"] as const)
          return { id: pid, sessionID, messageID: id, type, tool: "search", callID: pid,
            state: { status, ...(status === "completed" ? { output: text } : status === "error" ? { error: text } : {}) } }
        }
        return { id: pid, sessionID, messageID: id, type }
      })
      const target = pick(rng, [...parts.map((p) => p.id), "not-a-part"])
      const overlay = {
        message_id: id,
        excluded: rng() < .35,
        pinned: rng() < .2,
        override_data: rng() < .65 ? pick(rng, [
          { text: "override", partID: target },
          { collapsed: true, partID: target },
          { text: "override" },
          null,
        ]) : null,
      }
      const info = {
        id, sessionID, role: "user" as const, time: { created: 1000 + i },
        ...(stateOwned ? { provenance: SessionTurnProvenance.host(SessionTurnProvenance.Source.GoalProgress, {
          ref: "goal-state:v1:progress:gol_test:" + "a".repeat(64),
        }) } : {}),
      }
      const oracle = SessionLedger.buildWithRows(
        { sessionID, messages: [{ info, parts }] as any },
        [overlay] as any,
      )
      const actual = materializeContextMessage({
        parts: parts.map((part) => {
          const facts = contextPartFacts(part as any)
          return {
            id: part.id, kind: facts.context_kind, version: facts.context_projection_version,
            tokens: facts.context_tokens, signed: facts.context_signed,
            status: facts.context_status,
          }
        }),
        overlay: {
          excluded: overlay.excluded, pinned: overlay.pinned,
          override: overlay.override_data,
        },
        stateOwned,
        messageOpaque: false,
      })
      expect(actual).toEqual(oracle.totals)
    }
  })

  test("delta reverses edits, signatures, removals and repeated replay without drift", () => {
    const rng = random(92340924)
    const rows = new Map<string, ContextMaterializedTotals>()
    let totals: ContextMaterializedTotals = zeroContextMaterializedTotals
    for (let i = 0; i < 9_000; i++) {
      const id = `message_${Math.floor(rng() * 300)}`
      const before = rows.get(id)
      const action = rng()
      const after: ContextMaterializedTotals | undefined = action < .22
        ? undefined
        : { messageCount: 1, excludedCount: action < .45 ? 1 : 0,
          pinnedCount: action >= .8 ? 1 : 0, editedCount: action >= .7 && action < .8 ? 1 : 0,
          estimatedTokens: action < .45 ? 0 : Math.floor(rng() * 12000),
          estimatedTokensExcluded: action < .45 ? Math.floor(rng() * 12000) : 0 }
      if (after) rows.set(id, after)
      else rows.delete(id)
      totals = addContextMaterializedTotals(totals, contextMaterializedDelta(before, after))
      if (i % 173 === 0) {
        const reference = [...rows.values()].reduce(
          (sum, row) => addContextMaterializedTotals(sum, row), zeroContextMaterializedTotals,
        )
        expect(totals).toEqual(reference)
        expect(addContextMaterializedTotals(totals, contextMaterializedDelta(after, after))).toEqual(totals)
      }
    }
  })

  test("fails closed on missing v1 parts, unsafe estimates, opaque metadata, and compaction", () => {
    const base = { stateOwned: false, messageOpaque: false, parts: [
      { id: "part", version: 1, kind: "text", tokens: 13, signed: false, status: null },
    ] }
    expect(materializeContextMessage(base)?.estimatedTokens).toBe(17)
    expect(materializeContextMessage({ ...base, messageOpaque: true })).toBeNull()
    expect(materializeContextMessage({ ...base, parts: [{ ...base.parts[0]!, version: 0 }] })).toBeNull()
    expect(materializeContextMessage({ ...base, parts: [{ ...base.parts[0]!, tokens: -1 }] })).toBeNull()
    expect(materializeContextMessage({ ...base, parts: [{ ...base.parts[0]!, kind: "compaction" }] })).toBeNull()
    expect(() => addContextMaterializedTotals(zeroContextMaterializedTotals,
      { ...zeroContextMaterializedTotals, messageCount: -1 })).toThrow("underflow")
  })
})
