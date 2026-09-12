import { describe, expect, test } from "bun:test"
import {
  BoundedExactPeriodVerifier,
  canonicalMotif,
  fineWilfThreshold,
  minimalRotation,
  proveExactPeriod,
  verifyExactPeriodCandidate,
} from "@/session/spad/exact-proof"

function codes(text: string) {
  const out = new Uint16Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i)
  return out
}

function bruteMinimalPeriod(word: Uint16Array): number {
  for (let p = 1; p <= word.length; p++) {
    let ok = true
    for (let i = p; i < word.length; i++) {
      if (word[i] !== word[i - p]) {
        ok = false
        break
      }
    }
    if (ok) return p
  }
  return word.length
}

describe("SPAD bounded exact proof", () => {
  test("proves a proposed period and reduces harmonic periods to the minimum", () => {
    const span = codes("abc".repeat(20))
    const proof = proveExactPeriod(span, 12)
    expect(proof.ok).toBe(true)
    if (!proof.ok) return
    expect(proof.minimalPeriod).toBe(3)
    expect(proof.exponent).toBe(20)
    expect(proof.isFullPower).toBe(true)
    expect(proof.periodComparisons).toBe(span.length - 12)
  })

  test("rejects a false candidate before running prefix analysis", () => {
    const span = codes("abcabcabcXbcabc")
    const proof = proveExactPeriod(span, 3)
    expect(proof).toMatchObject({ ok: false, reason: "period-mismatch", prefixComparisons: 0 })
  })

  test("candidate-only verification proves exactness without prefix analysis", () => {
    const span = codes("wxyz".repeat(512))
    const accepted = verifyExactPeriodCandidate(span, 4)
    expect(accepted).toEqual({ ok: true, proposedPeriod: 4, spanLength: span.length, periodComparisons: span.length - 4 })
    span[1500]! ^= 1
    const rejected = verifyExactPeriodCandidate(span, 4)
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.reason).toBe("period-mismatch")
  })

  test("hard span budget prevents accidental unbounded verification", () => {
    const proof = proveExactPeriod(codes("abcd".repeat(3000)), 4, { maxSpan: 8192 })
    expect(proof).toEqual({ ok: false, reason: "span-limit", periodComparisons: 0, prefixComparisons: 0 })
  })

  test("reusable verifier preserves proof semantics without per-call scratch allocation", () => {
    const verifier = new BoundedExactPeriodVerifier({ maxSpan: 4096 })
    for (const period of [3, 16, 64, 257]) {
      const span = new Uint16Array(period * 4)
      for (let i = 0; i < span.length; i++) span[i] = 65 + (i % period)
      expect(verifier.prove(span, period)).toEqual(proveExactPeriod(span, period, { maxSpan: 4096 }))
    }
  })

  test("direct ring proof is identical to contiguous proof across wraparound", () => {
    const verifier = new BoundedExactPeriodVerifier({ maxSpan: 4096 })
    const ring = new Uint16Array(4096)
    const mask = ring.length - 1
    for (const period of [3, 16, 63, 257]) {
      const length = Math.min(3072, period * 8)
      const start = ring.length - Math.floor(length / 3)
      const span = new Uint16Array(length)
      for (let i = 0; i < length; i++) {
        const value = 65 + ((i % period) % 41)
        span[i] = value
        ring[(start + i) & mask] = value
      }
      expect(verifier.proveRing(ring, mask, start, length, period)).toEqual(verifier.prove(span, period))
    }
  })

  test("direct ring proof rejects the same false candidate", () => {
    const verifier = new BoundedExactPeriodVerifier({ maxSpan: 4096 })
    const span = codes("abcd".repeat(300))
    span[777]! ^= 1
    const ring = new Uint16Array(2048)
    const start = 1900
    for (let i = 0; i < span.length; i++) ring[(start + i) & (ring.length - 1)] = span[i]!
    expect(verifier.proveRing(ring, ring.length - 1, start, span.length, 4)).toEqual(verifier.prove(span, 4))
  })

  test("minimal-period formula matches brute force for every binary word through length 12", () => {
    for (let n = 2; n <= 12; n++) {
      for (let mask = 0; mask < 1 << n; mask++) {
        const word = new Uint16Array(n)
        for (let i = 0; i < n; i++) word[i] = 97 + ((mask >>> i) & 1)
        const proposed = bruteMinimalPeriod(word)
        if (proposed >= n) continue
        const proof = proveExactPeriod(word, proposed)
        expect(proof.ok, `n=${n} mask=${mask}`).toBe(true)
        if (proof.ok) expect(proof.minimalPeriod, `n=${n} mask=${mask}`).toBe(proposed)
      }
    }
  })

  test("Fine-Wilf threshold has the audited 192/288 -> 384 boundary", () => {
    expect(fineWilfThreshold(192, 288)).toBe(384)
    expect(fineWilfThreshold(96, 192)).toBe(192)
  })

  test("minimal rotation canonicalizes phase shifts", () => {
    expect(Array.from(minimalRotation(codes("cab")))).toEqual(Array.from(codes("abc")))
    expect(Array.from(minimalRotation(codes("bca")))).toEqual(Array.from(codes("abc")))
    expect(Array.from(minimalRotation(codes("abc")))).toEqual(Array.from(codes("abc")))
  })

  test("canonical motif reduces a harmonic proof before rotation", () => {
    const span = codes("bcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabcabca")
    const proof = proveExactPeriod(span, 6)
    expect(proof.ok).toBe(true)
    if (!proof.ok) return
    expect(proof.minimalPeriod).toBe(3)
    expect(Array.from(canonicalMotif(span, proof))).toEqual(Array.from(codes("abc")))
  })
})
