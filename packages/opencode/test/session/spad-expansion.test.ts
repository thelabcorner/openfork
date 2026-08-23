import { describe, expect, it } from "bun:test"
import { DEFAULT_SPAD_CONFIG } from "@/session/spad/config"
import { ExpansionLane } from "@/session/spad/expansion-lane"
import { makeTurnPolicy } from "@/session/spad/intent"
import { SpadSupervisor } from "@/session/spad/supervisor"
import { clearPersistedMotifs } from "@/session/spad/pattern-store"
import { readFileSync } from "node:fs"

const incidents = Array.from({ length: 16 }, (_, i) => `${i + 1}. sensor-${(i % 5) + 1} reported a transient read timeout`)

function expandingLedger(cycles: number) {
  const lines: string[] = []
  for (let k = 0; k < cycles; k++) {
    lines.push(`=== INCIDENT LEDGER (after cycle ${k + 1}) ===`)
    lines.push(...incidents.slice(0, k + 1))
    lines.push("")
  }
  return lines.join("\n") + "\n"
}

function expandingProse(cycles: number) {
  return (
    Array.from(
      { length: cycles },
      (_, c) =>
        ["Analysis follows.", ...Array.from({ length: c + 1 }, (_, i) => `Finding ${i + 1} remains unresolved.`), ""].join("\n"),
    ).join("\n") + "\n"
  )
}

/** Feed in arbitrary chunks to verify chunk invariance. */
function feed(sup: SpadSupervisor, text: string, chunks: number[]) {
  let action
  let index = 0
  outer: while (index < text.length) {
    for (const size of chunks) {
      if (index >= text.length) break outer
      action = sup.push(text.slice(index, index + size))
      index += size
      if (action) return action
    }
  }
  return action
}

describe("SPAD expansion lane", () => {
  it("detects an expanding restatement ledger", () => {
    const sup = new SpadSupervisor()
    sup.beginTurn(makeTurnPolicy("process the incidents", false))
    sup.startPart("text")
    const action = feed(sup, expandingLedger(16), [97])
    expect(action?.type).toBe("recover")
    if (action?.type === "recover") {
      expect(action.detection.lane).toBe("expansion")
      expect(action.detection.period).toBe(0)
      expect(action.detection.expansionDuplicateRatio).toBeGreaterThan(0)
      expect(action.noTruncate).toBeFalsy()
    }
  })

  it("detects prose restatement expansion", () => {
    const sup = new SpadSupervisor()
    sup.beginTurn(makeTurnPolicy("write findings", false))
    sup.startPart("text")
    expect(feed(sup, expandingProse(14), [31, 7])?.type).toBe("recover")
  })

  it("chunk invariance: single-shot and 1-char feeds both detect", () => {
    for (const chunks of [[expandingLedger(16).length], [1]] as number[][]) {
      const sup = new SpadSupervisor()
      sup.beginTurn(makeTurnPolicy("x", false))
      sup.startPart("text")
      expect(feed(sup, expandingLedger(16), chunks)?.type).toBe("recover")
    }
  })

  it("does not fire on real source code", () => {
    for (const file of [
      "src/session/spad/supervisor.ts",
      "src/session/processor.ts",
      "test/session/spad-frontier.test.ts",
      "test/lib/llm-server.ts",
    ]) {
      const sup = new SpadSupervisor()
      sup.beginTurn(makeTurnPolicy("x", false))
      sup.startPart("text")
      const action = feed(sup, readFileSync(file, "utf8"), [512])
      expect(action?.detection?.lane ?? "none").not.toBe("expansion")
    }
  })

  it("does not fire on diverse or templated prose", () => {
    const diverse = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i}: the analysis of subsystem ${i % 9} reveals constraint ${i * 3} interacts with the ${["cache", "index", "router"][i % 3]} during rollout ${i}.`,
    ).join("\n\n")
    const templated = Array.from({ length: 20 }, (_, i) => `## Day ${i + 1}\nStatus nominal.\nDetail note ${i}\n`).join("\n")
    for (const text of [diverse, templated]) {
      const sup = new SpadSupervisor()
      sup.beginTurn(makeTurnPolicy("x", false))
      sup.startPart("text")
      expect(feed(sup, text + "\n", [97])).toBeUndefined()
    }
  })

  it("observe-only and intent gates suppress expansion recovery", () => {
    clearPersistedMotifs()
    const observe = new SpadSupervisor()
    observe.beginTurn(makeTurnPolicy("x", true))
    observe.startPart("text", false, true)
    expect(feed(observe, expandingLedger(16), [97])?.type).toBe("observe")

    const intent = new SpadSupervisor()
    intent.beginTurn(makeTurnPolicy("copy the ledger exactly as shown for each cycle", false))
    intent.startPart("text")
    expect(feed(intent, expandingLedger(16), [97])?.type).toBe("observe")
  })

  it("escalates to abort when expansion continues after recovery", () => {
    clearPersistedMotifs()
    const sup = new SpadSupervisor()
    sup.beginTurn(makeTurnPolicy("x", false))
    sup.startPart("text")
    const first = feed(sup, expandingLedger(16), [97])
    expect(first?.type).toBe("recover")
    // Second generation relapses into the same expansion.
    sup.startPart("text", true)
    const second = feed(sup, expandingLedger(16), [97])
    expect(second !== undefined && (second.type === "recover" || second.type === "abort")).toBe(true)
  })

  it("recovery mode lowers the required cycles", () => {
    // Ten cycles produce exactly two completed minLines runs: below the
    // normal gate of three, at the recovery-mode gate of two.
    const text = expandingLedger(10)
    const normal = new ExpansionLane({ lane: "expansion", channel: "text", config: DEFAULT_SPAD_CONFIG })
    let detected
    for (let i = 0; i < text.length && !detected; i++) detected = normal.push(text.charCodeAt(i))
    expect(detected).toBeUndefined()

    const recovery = new ExpansionLane({
      lane: "expansion",
      channel: "text",
      config: DEFAULT_SPAD_CONFIG,
      recoveryMode: true,
    })
    let detectedRecovery
    for (let i = 0; i < text.length && !detectedRecovery; i++) detectedRecovery = recovery.push(text.charCodeAt(i))
    expect(detectedRecovery).toBeDefined()
  })
})
