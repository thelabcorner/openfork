import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import {
  OPENFORK_COMPAT_PROFILE_ENV,
  T3_CODE_COMPAT_PROFILE,
  T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
  localClientReportedVersion,
} from "../../src/compat/t3code"

/**
 * The reported T3/OpenCode version is a CONSUMER CONTRACT version, not an OpenFork release number,
 * and it is bounded by BOTH audited generations of T3 Code at once. This suite is the regression
 * owner for that dual-generation window so the constant cannot be "bumped" into a generation that
 * marks it broken without a failing test explaining why.
 *
 * Sources (read-only; T3 Code is a fixed upstream puzzle piece):
 * - Old audited baseline 0fcd5f90611451cca842689faea53b5450c022da.
 * - Latest stock T3 Code origin/main a21702d0e58ad20263dc965d84472bb6d7eb38c8,
 *   apps/server/src/provider/model-manifest.json, which carries TWO `opencode` driver entries:
 *     { t3CodeRange ">=0.0.42 <0.0.46", recommendedRange ">=1.14.19 <2.0.0",
 *       ranges: ">=2.0.0" broken | ">=1.14.19 <2.0.0" supported | "<1.14.19" broken }
 *     { t3CodeRange ">=0.0.46", recommendedRange ">=2.0.18",
 *       ranges: ">=2.0.18" supported | ">=2.0.0 <2.0.18" unsupported
 *              | ">=1.14.19 <2.0.0" graceful | "<1.14.19" broken }
 *
 * The intersection that keeps both generations alive is exactly [1.14.19, 2.0.0). Inside it the old
 * generation is "supported" and the latest generation is "graceful" (degraded, still functional).
 * Reporting >= 2.0.0 is "broken" for the old generation and "unsupported" for the latest one, and
 * OpenFork's facade implements the OpenCode 1.x wire rather than the 2.x `/api/*` protocol, so a 2.x
 * bump would be a regression dressed as an upgrade. It must never be derived from the OpenFork
 * product version.
 */

type Status = "supported" | "graceful" | "unsupported" | "broken"

/** Mirrors T3_CODE_COMPAT_EXECUTABLE without importing it, so the Dockerfile check is literal. */
const T3_CODE_COMPAT_EXECUTABLE_LITERAL = "openfork-t3code"

interface Semver {
  readonly major: number
  readonly minor: number
  readonly patch: number
  readonly prerelease: boolean
}

function parseSemver(value: string): Semver {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value.trim())
  if (!match) throw new Error(`unparseable semver: ${JSON.stringify(value)}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] !== undefined,
  }
}

function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major - right.major
  if (left.minor !== right.minor) return left.minor - right.minor
  if (left.patch !== right.patch) return left.patch - right.patch
  if (left.prerelease === right.prerelease) return 0
  // A prerelease sorts before its own release, matching T3's semver helper.
  return left.prerelease ? -1 : 1
}

/** Evaluates exactly the range forms T3's manifest uses: "=x", ">=x", "<x", and ">=x <y". */
function satisfiesRange(version: string, range: string): boolean {
  const actual = parseSemver(version)
  const clauses = range.split(/\s+/).filter(Boolean)
  if (clauses.length === 0) throw new Error(`empty range: ${JSON.stringify(range)}`)
  for (const clause of clauses) {
    if (clause.startsWith(">=")) {
      if (compareSemver(actual, parseSemver(clause.slice(2))) < 0) return false
      continue
    }
    if (clause.startsWith("<")) {
      if (compareSemver(actual, parseSemver(clause.slice(1))) >= 0) return false
      continue
    }
    if (clause.startsWith("=")) {
      if (compareSemver(actual, parseSemver(clause.slice(1))) !== 0) return false
      continue
    }
    throw new Error(`unsupported range clause: ${JSON.stringify(clause)}`)
  }
  return true
}

interface Generation {
  readonly label: string
  readonly source: string
  readonly recommendedRange: string
  readonly ranges: ReadonlyArray<{ readonly range: string; readonly status: Status }>
}

const OLD_T3: Generation = {
  label: "old audited T3 Code (0fcd5f90)",
  source: "docs/architecture/t3code-compatibility.md",
  recommendedRange: ">=1.14.19 <2.0.0",
  ranges: [
    { range: ">=2.0.0", status: "broken" },
    { range: ">=1.14.19 <2.0.0", status: "supported" },
    { range: "<1.14.19", status: "broken" },
  ],
}

const LATEST_T3: Generation = {
  label: "latest stock T3 Code (a21702d0e)",
  source: "apps/server/src/provider/model-manifest.json",
  recommendedRange: ">=2.0.18",
  ranges: [
    { range: ">=2.0.18", status: "supported" },
    { range: ">=2.0.0 <2.0.18", status: "unsupported" },
    { range: ">=1.14.19 <2.0.0", status: "graceful" },
    { range: "<1.14.19", status: "broken" },
  ],
}

/** T3 resolves exactly one status per version; mirroring that keeps the verdict unambiguous. */
function statusFor(generation: Generation, version: string): Status {
  const matched = generation.ranges.filter((entry) => satisfiesRange(version, entry.range))
  if (matched.length !== 1) {
    throw new Error(
      `${generation.label}: ranges are not a partition at ${version} (matched ${matched.length}: ${matched
        .map((entry) => entry.range)
        .join(", ")})`,
    )
  }
  return matched[0].status
}

const reported = localClientReportedVersion("0.0.0-openfork-test", {
  [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE,
})

describe("T3 Code dual-generation version window", () => {
  test("the audited ranges are a partition, so every version has exactly one verdict per generation", () => {
    for (const generation of [OLD_T3, LATEST_T3]) {
      for (const version of [
        "1.14.18",
        "1.14.19",
        T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
        "1.99.99",
        "2.0.0",
        "2.0.17",
        "2.0.18",
        "2.1.0",
        "3.0.0",
      ]) {
        expect(typeof statusFor(generation, version), `${generation.label} @ ${version}`).toBe("string")
      }
    }
  })

  test("the reported version is supported by the old audited generation", () => {
    expect(reported).toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
    expect(statusFor(OLD_T3, reported)).toBe("supported")
  })

  test("the reported version is graceful, never broken, on the latest stock generation", () => {
    expect(statusFor(LATEST_T3, reported)).toBe("graceful")
  })

  test("the reported version sits inside the intersection both generations accept", () => {
    for (const generation of [OLD_T3, LATEST_T3]) {
      const status = statusFor(generation, reported)
      expect(
        status === "supported" || status === "graceful",
        `${generation.label} rejects ${reported} as ${status}; it must stay inside [1.14.19, 2.0.0)`,
      ).toBe(true)
    }
  })

  // The guard has to have teeth, or the window test above proves nothing. These are the exact
  // "looks like an upgrade, is a regression" bumps a future maintainer is most likely to attempt.
  test.each([
    ["2.0.0", OLD_T3],
    ["2.0.0", LATEST_T3],
    ["2.0.17", OLD_T3],
    ["2.0.17", LATEST_T3],
    ["1.14.18", OLD_T3],
    ["1.14.18", LATEST_T3],
  ])("a report of %s is rejected by %s", (version, generation) => {
    expect(["broken", "unsupported"]).toContain(statusFor(generation, version))
  })

  test("the newest version both generations still accept is below 2.0.0", () => {
    const newest = ["1.14.19", "1.15.13", "1.99.99"].filter((version) =>
      ["supported", "graceful"].includes(statusFor(LATEST_T3, version)),
    )
    expect(newest.length).toBeGreaterThan(0)
    for (const version of newest) expect(parseSemver(version).major).toBe(1)
  })

  // Generation follows the DECODED VERSION, not the probe path: T3's `probed()` returns
  // `{generation: major >= 2 ? "v2" : "v1"}`. A decodable `/api/info` body reporting 1.x is
  // still v1, so the load-bearing invariant is `major < 2` on whatever version reaches the
  // probe, not the absence of an `/api/info` route. Asserted directly so it survives a future
  // change to either audited manifest.
  test("the reported version's major is below 2, which is what keeps T3 on the v1 driver", () => {
    expect(parseSemver(reported).major).toBeLessThan(2)
    expect(reported).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test("canonical OpenFork identity is untouched by the profile", () => {
    expect(localClientReportedVersion("2.7.0", {})).toBe("2.7.0")
    expect(localClientReportedVersion("2.7.0", { [OPENFORK_COMPAT_PROFILE_ENV]: "some-other-client" })).toBe(
      "2.7.0",
    )
    expect(localClientReportedVersion("2.7.0")).not.toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
  })

  // The generated launcher and the container build consume this constant in different ways: the
  // launcher template imports it, but the Dockerfile hardcodes the literal. Drift there would ship
  // a container whose own build-time assertion disagrees with the facade it is asserting.
  test("the container build's hardcoded assertion agrees with the reported version", () => {
    const dockerfile = fileURLToPath(new URL("../../Dockerfile", import.meta.url))
    const contents = readFileSync(dockerfile, "utf8")
    expect(contents).toContain(T3_CODE_COMPAT_EXECUTABLE_LITERAL)
    expect(contents).toContain(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
  })
})
