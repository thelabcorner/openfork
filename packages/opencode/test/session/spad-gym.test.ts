import { describe, expect, test } from "bun:test"
import { DEFAULT_EXACT_BANDS, DEFAULT_SPAD_CONFIG } from "@/session/spad/config"
import { SpadSupervisor } from "@/session/spad/supervisor"
import { makeTurnPolicy } from "@/session/spad/intent"
import type { SpadAction, SpadConfig } from "@/session/spad/types"
import { counterfactualPairs, negativeCases, type ProtectedNegativeClass, type TextCase } from "./spad-gym-fixtures"

function runText(input: TextCase, config: SpadConfig = DEFAULT_SPAD_CONFIG, chunks: readonly number[] = [97, 31, 7]) {
  const sup = new SpadSupervisor(config)
  sup.beginTurn(makeTurnPolicy(input.user ?? "Continue the task.", input.structured ?? false))
  sup.startPart("text")
  let at = 0
  let i = 0
  let firstObserve: SpadAction | undefined
  while (at < input.text.length) {
    const size = chunks[i++ % chunks.length]!
    const action = sup.push(input.text.slice(at, at + size))
    if (action?.type === "recover" || action?.type === "abort") return action
    firstObserve ??= action
    at += size
  }
  return firstObserve
}

function isIntervention(action: SpadAction | undefined) {
  return action?.type === "recover" || action?.type === "abort"
}

function exactLoop(motif: string, repeats: number, prefix = "Healthy prefix.\n") {
  return prefix + motif.repeat(repeats)
}

function canonicalOnlyDrift(lines = 36) {
  const rand = seeded(0xc4110a1)
  const base = "The controller should re anchor to the user request and continue differently."
  return Array.from({ length: lines }, () => {
    let out = ""
    for (const ch of base) {
      if (ch === " ") {
        const spaces = [" ", "  ", "\t", "\n", " \t "]
        out += spaces[rand() % spaces.length]!
        continue
      }
      if (ch >= "A" && ch <= "Z" || ch >= "a" && ch <= "z") {
        out += (rand() & 1) === 0 ? ch.toLowerCase() : ch.toUpperCase()
        continue
      }
      out += ch
    }
    return out
  }).join("\n")
}

function seeded(seed: number) {
  let x = seed >>> 0
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return x >>> 0
  }
}

function minimalPeriod(text: string) {
  if (text.length <= 1) return text.length
  const pi = new Int32Array(text.length)
  for (let i = 1; i < text.length; i++) {
    let j = pi[i - 1]!
    while (j > 0 && text.charCodeAt(i) !== text.charCodeAt(j)) j = pi[j - 1]!
    if (text.charCodeAt(i) === text.charCodeAt(j)) j++
    pi[i] = j
  }
  return text.length - pi[text.length - 1]!
}

function primitiveMotif(period: number) {
  if (period === 1) return "a"
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789,.;:!?_+-=/|~"
  for (let attempt = 0; attempt < 64; attempt++) {
    const rand = seeded(0x51ad0000 ^ Math.imul(period + attempt * 131, 0x9e3779b1))
    const chars = new Array<string>(period)
    for (let i = 0; i < period; i++) chars[i] = alphabet[rand() % alphabet.length]!
    // Keep non-trivial periods out of the low-lexical special case.
    if (period >= 5) {
      chars[0] = "a"
      chars[1] = "b"
      chars[2] = "c"
      chars[3] = "d"
      chars[4] = "e"
    }
    const motif = chars.join("")
    if (minimalPeriod(motif) === period) return motif
  }
  throw new Error(`failed to create primitive motif period=${period}`)
}

function rawThreshold(period: number) {
  const band = DEFAULT_EXACT_BANDS.find((row) => period <= row.maxPeriod) ?? DEFAULT_EXACT_BANDS.at(-1)!
  return Math.max(band.minCoverage, Math.ceil(period * band.minExponent))
}

function repeatedPrefix(motif: string, chars: number) {
  return motif.repeat(Math.ceil(chars / motif.length)).slice(0, chars)
}


describe("SPAD gym — precision-first production profile", () => {
  test("default profile exposes only the exact raw lane for destructive recovery", () => {
    expect(DEFAULT_SPAD_CONFIG.autoRecoverRaw).toBe(true)
    expect(DEFAULT_SPAD_CONFIG.autoRecoverInsideCodeFence).toBe(false)
    expect(DEFAULT_SPAD_CONFIG.autoRecoverCanonical).toBe(false)
    expect(DEFAULT_SPAD_CONFIG.autoRecoverExpansion).toBe(false)
    expect(DEFAULT_SPAD_CONFIG.autoRecoverPersistedMotifs).toBe(false)
    expect(DEFAULT_SPAD_CONFIG.autoRecoverToolLoop).toBe(false)
    expect(DEFAULT_SPAD_CONFIG.autoRecoverThrash).toBe(false)
    expect(DEFAULT_SPAD_CONFIG.recoveryThresholdMultiplier).toBe(1)
  })

  test("negative corpus has zero destructive interventions", () => {
    const failures: string[] = []
    for (const item of negativeCases) {
      const action = runText(item)
      if (isIntervention(action)) failures.push(`${item.name}:${action!.type}:${action!.detection.lane}`)
    }
    expect(failures).toEqual([])
  })

  test("protected negative classes individually have zero destructive interventions", () => {
    const classes = new Map<ProtectedNegativeClass, { cases: number; chars: number; interventions: number }>()
    for (const item of negativeCases) {
      const row = classes.get(item.class) ?? { cases: 0, chars: 0, interventions: 0 }
      row.cases++
      row.chars += item.text.length
      if (isIntervention(runText(item))) row.interventions++
      classes.set(item.class, row)
    }
    expect(classes.size).toBe(16)
    for (const [name, row] of classes) {
      expect(row.cases, name).toBeGreaterThan(0)
      expect(row.chars, name).toBeGreaterThan(0)
      expect(row.interventions, name).toBe(0)
    }
  })

  test("counterfactual near-boundary pairs preserve healthy side and recover exact replay", () => {
    for (const pair of counterfactualPairs) {
      const healthy = runText(pair.healthy)
      const degenerate = runText(pair.degenerate)
      expect(isIntervention(healthy), `${pair.name}:healthy`).toBe(false)
      expect(degenerate?.type, `${pair.name}:degenerate`).toBe("recover")
      expect(degenerate?.detection.lane, `${pair.name}:lane`).toBe("raw")
      expect(degenerate?.detection.exactVerifiedSpan, `${pair.name}:proof`).toBeGreaterThan(0)
    }
  })

  test("iterative read/edit/test workflow with genuine state progress is protected even when thrash recovery is enabled", () => {
    const config: SpadConfig = { ...DEFAULT_SPAD_CONFIG, autoRecoverThrash: true }
    const sup = new SpadSupervisor(config)
    sup.beginTurn(makeTurnPolicy("Fix the implementation and validate each step."))
    let destructive: SpadAction | undefined
    for (let generation = 0; generation < 8; generation++) {
      sup.markGeneration()
      sup.startPart("text")
      sup.push(`Generation ${generation}: inspect the target, apply a bounded change, and rerun the focused test with new evidence ${generation}.`)
      const read = sup.pushTool("read", false, `src/module-${generation % 3}.ts:o${generation * 20}`)
      if (isIntervention(read)) destructive = read
      const edit = sup.pushTool("edit", true, `src/module-${generation % 3}.ts:mrev-${generation}`)
      if (isIntervention(edit)) destructive = edit
      const testRun = sup.pushTool("bash", false, `bun-test:case-${generation}`)
      if (isIntervention(testRun)) destructive = testRun
    }
    expect(destructive).toBeUndefined()
  })

  test("high-confidence exact attractors still recover", () => {
    const positives = [
      exactLoop("The model has entered the same continuation and is not making progress. ", 14),
      exactLoop("alpha beta gamma delta epsilon. ", 30),
      "!".repeat(1800),
      exactLoop("A long paragraph-scale motif should be interrupted only after several verified copies. This sentence adds enough lexical diversity to avoid a trivial short period. ", 12),
    ]
    for (const text of positives) {
      const action = runText({ name: "positive", text })
      expect(action?.type).toBe("recover")
      expect(action?.detection.lane).toBe("raw")
      expect(action?.detection.exactVerifiedSpan).toBeGreaterThan(action?.detection.period ?? Number.POSITIVE_INFINITY)
      expect(action?.detection.exactMinimalPeriod).toBeGreaterThan(0)
    }
  })

  test("real formatting-token degeneration regression recovers at exact period 10", () => {
    const text =
      "The response is becoming malformed while trying to emit formatting tokens. §" +
      "bold-hold-".repeat(80)
    const action = runText({ name: "historical formatting degeneration", class: "prose", text }, DEFAULT_SPAD_CONFIG, [17, 31, 7])
    expect(action?.type).toBe("recover")
    expect(action?.detection.lane).toBe("raw")
    expect(action?.detection.period).toBe(10)
    expect(action?.detection.exactMinimalPeriod).toBe(10)
    expect(action?.detection.runLength).toBeGreaterThanOrEqual(640)
  })

  test("every exact threshold-band edge is negative one char early and positive shortly after the floor", () => {
    const periods = [1, 4, 5, 16, 17, 64, 65, 256, 257, 768, 769, 4096]
    for (const period of periods) {
      const motif = primitiveMotif(period)
      const floor = rawThreshold(period)
      const prefix = `Healthy boundary fixture p=${period}. §`

      const early = runText(
        { name: `period-${period}-floor-minus-one`, class: "prose", text: prefix + repeatedPrefix(motif, floor - 1) },
        DEFAULT_SPAD_CONFIG,
        [37, 11, 3],
      )
      expect(isIntervention(early), `period=${period} floor=${floor}: early`).toBe(false)

      const positive = runText(
        { name: `period-${period}-positive`, class: "prose", text: prefix + repeatedPrefix(motif, floor + 32) },
        DEFAULT_SPAD_CONFIG,
        [37, 11, 3],
      )
      expect(positive?.type, `period=${period} floor=${floor}: type`).toBe("recover")
      expect(positive?.detection.lane, `period=${period}: lane`).toBe("raw")
      expect(positive?.detection.exactMinimalPeriod, `period=${period}: minimal`).toBe(period)
      expect(positive?.detection.runLength, `period=${period}: timing`).toBeGreaterThanOrEqual(floor)
      expect(positive?.detection.runLength, `period=${period}: latency`).toBeLessThanOrEqual(floor + 32)
    }
  })

  test("raw degeneration recovery budget is bounded and escalates persistent relapse to abort", () => {
    const sup = new SpadSupervisor()
    sup.beginTurn(makeTurnPolicy("Continue the task and make progress."))
    const motif = "The model is repeating this exact continuation instead of progressing. "
    const text = motif.repeat(20)

    const feedUntilAction = () => {
      let action: SpadAction | undefined
      for (let i = 0; i < text.length && !action; i += 23) action = sup.push(text.slice(i, i + 23))
      return action
    }

    sup.startPart("text")
    const first = feedUntilAction()
    expect(first?.type).toBe("recover")
    expect(first?.detection.lane).toBe("raw")

    sup.startPart("text", true)
    const second = feedUntilAction()
    expect(second?.type).toBe("recover")

    sup.startPart("text", true)
    const third = feedUntilAction()
    expect(third?.type).toBe("abort")
    if (third?.type === "abort") expect(third.reason).toBe("relapse")
  })

  test("tool-loop positive boundaries recover sustained exact cycles but never before 24 calls", () => {
    const config: SpadConfig = { ...DEFAULT_SPAD_CONFIG, autoRecoverToolLoop: true }
    for (const period of [1, 2, 4, 8, 16]) {
      const sup = new SpadSupervisor(config)
      sup.beginTurn(makeTurnPolicy("Investigate the issue and stop if the tool workflow gets stuck."))
      sup.startPart("text")
      let action: SpadAction | undefined
      for (let i = 0; i < 23; i++) {
        action = sup.pushTool("read", false, `resource-${i % period}`)
        expect(isIntervention(action), `period=${period} call=${i + 1}: early`).toBe(false)
      }
      for (let i = 23; i < 128 && !isIntervention(action); i++)
        action = sup.pushTool("read", false, `resource-${i % period}`)
      expect(action?.type, `period=${period}: type`).toBe("recover")
      expect(action?.detection.lane, `period=${period}: lane`).toBe("tool")
      expect(action?.detection.period, `period=${period}: detected period`).toBe(period)
    }
  })

  test("cached text and reasoning detectors are isolated across part resets", () => {
    const sup = new SpadSupervisor()
    sup.beginTurn(makeTurnPolicy("Continue with distinct parts."))
    const motif = "bold-hold-"
    const almostEnough = repeatedPrefix(motif, rawThreshold(motif.length) - 1)

    sup.startPart("text")
    let first: SpadAction | undefined
    for (let i = 0; i < almostEnough.length; i += 29) {
      const action = sup.push(almostEnough.slice(i, i + 29))
      if (isIntervention(action)) first = action
    }
    expect(first).toBeUndefined()

    // Starting another text part must not stitch its prefix onto the previous
    // cached detector's near-threshold suffix.
    sup.startPart("text")
    let second: SpadAction | undefined
    const shortText = repeatedPrefix(motif, 160)
    for (let i = 0; i < shortText.length; i += 17) {
      const action = sup.push(shortText.slice(i, i + 17))
      if (isIntervention(action)) second = action
    }
    expect(second).toBeUndefined()

    // Exercise the other cached detector, then switch back. Neither channel's
    // state may survive startPart().
    sup.startPart("reasoning", false, true)
    const shortReasoning = repeatedPrefix(motif, 320)
    for (let i = 0; i < shortReasoning.length; i += 23) sup.push(shortReasoning.slice(i, i + 23))
    sup.startPart("text")
    let afterReasoning: SpadAction | undefined
    for (let i = 0; i < shortText.length; i += 19) {
      const action = sup.push(shortText.slice(i, i + 19))
      if (isIntervention(action)) afterReasoning = action
    }
    expect(afterReasoning).toBeUndefined()
  })

  test("canonical drift is detected but cannot mutate output by default", () => {
    const text = canonicalOnlyDrift()
    const action = runText({ name: "canonical", text })
    expect(action?.type).toBe("observe")
    expect(action?.detection.lane).toBe("canonical")
  })

  test("gray-zone observations enqueue bounded neutral auditor evidence", () => {
    const sup = new SpadSupervisor()
    sup.beginTurn(makeTurnPolicy("Compare the approaches and keep useful changes."))
    sup.startPart("text")
    const text = canonicalOnlyDrift()
    for (let i = 0; i < text.length; i += 19) {
      const action = sup.push(text.slice(i, i + 19))
      if (action) break
    }
    const queued = sup.takeAuditCases()
    expect(queued.length).toBe(1)
    expect(queued[0]?.detection.source).toBe("canonical-period")
    expect(queued[0]?.intentIndependent.candidateHead.length).toBeGreaterThan(0)
    expect(queued[0]?.intentIndependent.candidateHead.length).toBeLessThanOrEqual(1200)
    expect(queued[0]?.intentIndependent.candidateTail.length).toBeLessThanOrEqual(1200)
    expect(queued[0]?.intentIndependent.features.period).toBeGreaterThan(0)
    expect(sup.takeAuditCases()).toEqual([])
  })

  test("reasoning cannot acquire destructive authority through a caller flag", () => {
    const sup = new SpadSupervisor()
    sup.beginTurn(makeTurnPolicy("Continue the task."))
    sup.startPart("reasoning", false, false)
    const motif = "The hidden reasoning state is repeating the same exact sentence without progress. "
    const text = motif.repeat(16)
    let action: SpadAction | undefined
    for (let i = 0; i < text.length; i += 17) {
      action = sup.push(text.slice(i, i + 17))
      if (action) break
    }
    expect(action?.type).toBe("observe")
    expect(action?.policyReason).toBe("reasoning-observe-only")
  })

  test("chunking cannot convert a healthy fixture into an intervention", () => {
    for (const item of negativeCases) {
      for (const chunks of [[1], [3, 11, 47], [256], [1024, 17]] as const) {
        expect(isIntervention(runText(item, DEFAULT_SPAD_CONFIG, chunks)), `${item.name} chunks=${chunks.join(",")}`).toBe(false)
      }
    }
  })

  test("adversarial templated fuzz has zero destructive interventions", () => {
    const rand = seeded(0x51adbeef)
    const nouns = ["session", "processor", "router", "worker", "buffer", "cache", "message", "tool", "result", "module", "stream"]
    const verbs = ["reads", "updates", "checks", "compares", "records", "validates", "loads", "writes"]
    for (let c = 0; c < 500; c++) {
      let text = ""
      const rows = 80 + (rand() % 180)
      for (let i = 0; i < rows; i++) {
        const noun = nouns[rand() % nouns.length]!
        const verb = verbs[rand() % verbs.length]!
        text += `${i + 1}. The ${noun} ${verb} item-${(rand() % 97) + 1} with status-${rand() % 13} and attempt-${rand() % 5}.\n`
        if (rand() % 9 === 0) text += `   - key insight: ${noun} remains consistent while value ${rand() % 10000} changes.\n`
      }
      const action = runText({ name: `fuzz-${c}`, text }, DEFAULT_SPAD_CONFIG, [1 + (rand() % 211)])
      expect(isIntervention(action), `case=${c} lane=${action?.detection.lane}`).toBe(false)
    }
  })
})
