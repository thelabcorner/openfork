import { describe, expect, test } from "bun:test"
import { SpadDetector, SpadSupervisor, makeTurnPolicy, repetitionExpected } from "@/session/spad"
import type { PeriodDetection } from "@/session/spad/types"

function feed(detector: SpadDetector, text: string, chunks: readonly number[] = [text.length]) {
  let offset = 0
  let found: PeriodDetection | undefined
  let index = 0
  while (offset < text.length) {
    const size = chunks[index++ % chunks.length] ?? text.length
    found ??= detector.push(text.slice(offset, offset + size))
    offset += size
  }
  return found
}

function xorshift(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    return value >>> 0
  }
}

const normalParagraph = "A streaming detector should distinguish ordinary lexical reuse from a genuine periodic attractor. The implementation keeps bounded state and verifies every hash-proposed period against actual symbols. Repeated technical terms are common in engineering prose, but continuous byte-level periodicity across several complete cycles is not. Tool output is excluded by the integration layer, while generated text and reasoning can be supervised independently. The recovery path is deliberately conservative because terminating valid work is more expensive than allowing a few hundred extra characters of a bad continuation."

describe("SPAD-R core", () => {
  test("normal prose does not trigger", () => {
    expect(feed(new SpadDetector({ channel: "text" }), normalParagraph, [1, 3, 7, 19])).toBeUndefined()
  })

  test("semantic analysis paralysis remains outside the exact attractor lane", () => {
    const trace = [
      "Let me inspect the lifecycle test around the failing assertion and compare it with the webhook response.",
      "I see the test uses the real coordinator. Let me read the coordinator implementation before changing anything.",
      "The coordinator stores active devices rather than slot counts. Let me inspect the webhook worker next.",
      "The webhook returns ok true with applied false for a seat-floor refusal. Let me check the adapter calculation.",
      "The adapter derives the quantity from subscription items. Let me reread the lifecycle setup to verify the fixture.",
      "The fixture appears consistent, so let me inspect the response body helper and rerun the failing test.",
      "The response helper returns the raw response and bodyOf parses JSON. Let me look at the adapter one more time.",
      "The adapter still appears to compute the expected value. I am stepping back and will identify the concrete mismatch.",
    ].join("\n\n")
    expect(feed(new SpadDetector({ channel: "text" }), trace, [17, 3, 41])).toBeUndefined()
  })

  test("sentence-level exact loop triggers", () => {
    const prefix = "We inspected the implementation and found the boundary. "
    const motif = "The session processor should preserve the completed tool state before continuing. "
    const hit = feed(new SpadDetector({ channel: "text" }), prefix + motif.repeat(10), [5, 17, 2, 31])
    expect(hit?.lane).toBe("raw")
    expect(hit?.period).toBeLessThanOrEqual(motif.length * 2)
    expect(hit?.runStart).toBeGreaterThanOrEqual(prefix.length - (hit?.period ?? 0))
  })

  test("long paragraph loop triggers after few cycles", () => {
    const motif = ("This is a long generated paragraph with enough changing vocabulary to avoid short accidental periods. " + "Its purpose is to test paragraph-scale attractors in a bounded streaming detector. ").repeat(5)
    const hit = feed(new SpadDetector({ channel: "text" }), "healthy prefix\n" + motif.repeat(5), [127, 13, 64])
    expect(hit?.lane).toBe("raw")
    expect(hit?.period).toBeGreaterThan(64)
  })

  test("short-period separator does not trigger prematurely", () => {
    expect(feed(new SpadDetector({ channel: "text" }), "=".repeat(600), [23])).toBeUndefined()
  })

  test("pathological single-symbol stream eventually triggers", () => {
    expect(feed(new SpadDetector({ channel: "text" }), "!".repeat(1400), [29])?.period).toBe(1)
  })

  test("incrementing JSON-like records do not trigger exact lane", () => {
    let text = "[\n"
    for (let i = 0; i < 1500; i++) text += `  {"id":${i},"value":"row-${i}","ok":true},\n`
    text += "]"
    const hit = feed(new SpadDetector({ channel: "text" }), text, [64, 127, 11])
    expect(!hit || hit.lane !== "raw").toBe(true)
  })

  test("canonical lane catches case and whitespace drift", () => {
    const base = "The Recovery Controller Must Re Anchor To The User Request And Continue Differently."
    const variants = [base, base.toLowerCase().replaceAll(" ", "  "), base.toUpperCase().replaceAll(" ", "\n"), base.replaceAll(" ", "\t"), base.toLowerCase()]
    let text = ""
    for (let i = 0; i < 20; i++) text += variants[i % variants.length] + "\n"
    const hit = feed(new SpadDetector({ channel: "text" }), text, [9, 21, 4])
    expect(hit?.lane).toBe("canonical")
    expect(hit?.canonicalDuplicate4GramRatio).toBeGreaterThan(0.5)
  })

  test("chunking is invariant", () => {
    const motif = "A deterministic streaming algorithm must not depend on provider chunk boundaries. "
    const text = "prefix " + motif.repeat(12)
    const a = feed(new SpadDetector({ channel: "text" }), text, [1])
    const b = feed(new SpadDetector({ channel: "text" }), text, [7, 31, 2, 101])
    const c = feed(new SpadDetector({ channel: "text" }), text)
    expect(a && b && c).toBeTruthy()
    expect(a?.period).toBe(b?.period)
    expect(b?.period).toBe(c?.period)
    expect(a?.runStart).toBe(b?.runStart)
    expect(b?.runStart).toBe(c?.runStart)
  })

  test("explicit repetition intent disables intervention", () => {
    expect(repetitionExpected("Print foo exactly 1000 times.")).toBe(true)
    expect(repetitionExpected("Do not repeat the same phrase over and over.")).toBe(false)
    const supervisor = new SpadSupervisor()
    supervisor.beginTurn(makeTurnPolicy("Print foo exactly 1000 times."))
    supervisor.startPart("text")
    let action
    const payload = "foo ".repeat(600)
    for (let i = 0; i < payload.length; i += 37) action ??= supervisor.push(payload.slice(i, i + 37))
    expect(action?.type).toBe("observe")
  })

  test("structured output policy is observe-only", () => {
    const supervisor = new SpadSupervisor()
    supervisor.beginTurn(makeTurnPolicy("Return the result.", true))
    supervisor.startPart("text")
    const motif = '{"status":"same","value":42}\n'
    let action
    const payload = motif.repeat(30)
    for (let i = 0; i < payload.length; i += 13) action ??= supervisor.push(payload.slice(i, i + 13))
    expect(action?.type).toBe("observe")
  })

  test("reasoning channel can be observed without enabling mutation", () => {
    const supervisor = new SpadSupervisor()
    supervisor.beginTurn(makeTurnPolicy("Continue implementing the feature."))
    supervisor.startPart("reasoning", false, true)
    const motif = "The reasoning state should return to the last stable checkpoint. "
    let action
    const payload = motif.repeat(12)
    for (let i = 0; i < payload.length; i += 19) action ??= supervisor.push(payload.slice(i, i + 19))
    expect(action?.type).toBe("observe")
  })

  test("recovery escalates from recover to recover to abort", () => {
    const supervisor = new SpadSupervisor()
    supervisor.beginTurn(makeTurnPolicy("Continue implementing the feature."))
    supervisor.startPart("text")
    const motif = "The implementation should continue from the previous stable state without repeating this sentence. "
    const loop = motif.repeat(12)
    let first
    for (let i = 0; i < loop.length; i += 41) { first = supervisor.push(loop.slice(i, i + 41)); if (first?.type === "recover") break }
    expect(first?.type).toBe("recover")
    expect(first?.type === "recover" ? first.attempt : 0).toBe(1)
    supervisor.startPart("text", true)
    const relapse = motif.repeat(4)
    let second
    for (let i = 0; i < relapse.length; i += 17) { second = supervisor.push(relapse.slice(i, i + 17)); if (second) break }
    expect(second?.type).toBe("recover")
    expect(second?.type === "recover" ? second.attempt : 0).toBe(2)
    supervisor.startPart("text", true)
    let third
    for (let i = 0; i < relapse.length; i += 17) { third = supervisor.push(relapse.slice(i, i + 17)); if (third) break }
    expect(third?.type).toBe("abort")
  })

  test("random healthy fuzz has zero raw triggers", () => {
    const random = xorshift(0xdecafbad)
    const words = ["session", "processor", "model", "cache", "tool", "result", "stream", "context", "message", "state", "value", "function", "runtime", "client", "server", "response", "reasoning", "output", "input", "system", "agent", "stable", "change", "update", "verify", "buffer"]
    for (let caseNo = 0; caseNo < 300; caseNo++) {
      let text = ""
      for (let i = 0; i < 500; i++) { text += words[random() % words.length]!; text += random() % 11 === 0 ? ".\n" : " "; if (random() % 41 === 0) text += "The implementation remains deterministic. " }
      const hit = feed(new SpadDetector({ channel: "text" }), text, [1 + (random() % 97)])
      expect(!hit || hit.lane !== "raw").toBe(true)
    }
  })

  test("random injected loops are detected", () => {
    const random = xorshift(0x12345678)
    for (let caseNo = 0; caseNo < 100; caseNo++) {
      const period = 24 + (random() % 220)
      let motif = ""
      for (let i = 0; i < period; i++) motif += String.fromCharCode(97 + (random() % 26))
      const repeats = period <= 64 ? 10 : 7
      const hit = feed(new SpadDetector({ channel: "text" }), `healthy-${caseNo}-` + normalParagraph.slice(0, 200) + motif.repeat(repeats), [1 + (random() % 113)])
      expect(hit?.lane).toBe("raw")
    }
  })

  test("SQL bulk insert with changing values does not exact-trigger", () => {
    let text = "BEGIN;\n"
    for (let i = 0; i < 2500; i++) text += `INSERT INTO t(id,name,score) VALUES (${i},'row_${i}',${(i * 17) % 997});\n`
    const hit = feed(new SpadDetector({ channel: "text" }), text + "COMMIT;", [211, 17, 89])
    expect(!hit || hit.lane !== "raw").toBe(true)
  })

  test("Markdown table with changing cells does not exact-trigger", () => {
    let text = "| id | name | value |\n|---:|---|---:|\n"
    for (let i = 0; i < 2500; i++) text += `| ${i} | item-${i} | ${(i * 13) % 1009} |\n`
    const hit = feed(new SpadDetector({ channel: "text" }), text, [97, 31])
    expect(!hit || hit.lane !== "raw").toBe(true)
  })

  test("900-character horizontal rule remains below intervention threshold", () => {
    expect(feed(new SpadDetector({ channel: "text" }), "-".repeat(900), [37])).toBeUndefined()
  })

  test("code fence raises coverage requirement", () => {
    const motif = "const stableValue = computeStableValue(input);\n"
    expect(feed(new SpadDetector({ channel: "text" }), motif.repeat(7), [17])).toBeTruthy()
    expect(feed(new SpadDetector({ channel: "text" }), "```ts\n" + motif.repeat(7), [17])).toBeUndefined()
    expect(feed(new SpadDetector({ channel: "text" }), "```ts\n" + motif.repeat(16), [17])).toBeTruthy()
  })
})
