import { describe, expect, test } from "bun:test"
import { OxpAttributionCalibration as Calibration } from "@opencode-ai/core/oxp-attribution/calibration"

describe("OXP attribution calibration artifacts", () => {
  test("exposes a production profile and a neutral payload digest", () => {
    expect(Calibration.status.productionDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(Calibration.status.payloadDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(Calibration.status.productionDigest).not.toBe(Calibration.status.payloadDigest)
  })

  test("carries the legacy corpus window required by historical backfill", () => {
    // The backfill gate must never silently match fewer rows because the corpus
    // window went missing from the neutral payload artifact.
    expect(Number.isFinite(Calibration.status.corpus.maxStartedAt)).toBe(true)
    expect(Calibration.status.corpus.maxStartedAt).toBeGreaterThan(0)
  })

  test("payload artifact no longer advertises geometric-residency semantics", () => {
    const serialized = JSON.stringify(Calibration.artifact)
    expect(serialized).not.toContain("rho")
    expect(serialized).not.toContain("amplification")
    expect(serialized).not.toContain("residency")
  })

  test("tokenizer ratios and upstream dimensions are internally consistent", () => {
    expect(Calibration.requestCharsPerToken).toBeGreaterThan(0)
    expect(Calibration.resultCharsPerToken).toBeGreaterThan(0)
    const width = Calibration.upstream.features.length
    expect(Calibration.upstream.coefficients).toHaveLength(width)
    expect(Calibration.upstream.means).toHaveLength(width)
    expect(Calibration.upstream.stds).toHaveLength(width)
    expect(Calibration.upstream.stds.every((value) => value > 0)).toBe(true)
  })

  test("donor lookup is status-specialized and never invents population", () => {
    expect(Calibration.requestDonorChars("read", "success")).toBeGreaterThan(0)
    expect(Calibration.requestDonorChars("read", "definitely-unknown-status")).toBeUndefined()
    expect(Calibration.resultDonorChars("read", "definitely-unknown-status")).toBeUndefined()
  })

  test("documents the target and validation window in status", () => {
    expect(Calibration.status.corpus.pairedMessages).toBeGreaterThan(0)
    expect(Calibration.status.corpus.sessions).toBeGreaterThan(0)
    expect(Calibration.status.tokenizer.encoding).toBe("o200k_base")
    expect(Calibration.status.validation.cvSessionWAPE).toBeGreaterThan(0)
  })
})
