import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Option, Redacted, Schema } from "effect"
import { SessionStatusEvent } from "@opencode-ai/schema/session-status-event"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { ServerAuth } from "../../src/server/auth"
import {
  OPENFORK_COMPAT_PROFILE_ENV,
  T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
  T3_CODE_COMPAT_PROFILE,
  canonicalT3CodeModelRef,
  canonicalT3CodeModelSlug,
  localClientReportedVersion,
  t3CodeAccountModelID,
} from "../../src/compat/t3code"

/**
 * Adversarial / negative forward-compatibility contract for the T3 Code facade.
 *
 * WHY THIS FILE EXISTS
 *
 * The dominant failure mode of the whole T3 compatibility mission is SILENT
 * v1 -> v2 MISCLASSIFICATION, not a visible error. Stock T3 decides which
 * generation to drive by probing the OpenCode server: it tries `GET /api/info`
 * first and only falls through to `GET /global/health`. A 200
 * `application/json` `{version, pid}` body on `/api/info` is read as v2. If
 * OpenFork ever satisfies that probe, T3 switches to `@opencode/client` 2.0.18
 * against a v1-shaped server and every compatibility lane breaks at once, with
 * no T3-side error naming the cause.
 *
 * There are TWO independent ways to trigger that flip, and only the first is
 * about routes:
 *
 *   1. A 200-JSON `/api/info` route appears (load-bearing ABSENCE).
 *   2. The version string OpenFork reports becomes major >= 2.
 *
 * The second is the more dangerous one because it needs no new code at all: it
 * fires from a routine release. `/global/health` serves
 * `localClientReportedVersion(InstallationVersion)` on BOTH the T3-profile and
 * canonical branches (src/server/routes/instance/httpapi/handlers/global.ts),
 * and only the profile branch pins `1.15.13`. T3's own decode of
 * `/global/health` requires just `{healthy: true, version: string}` and ignores
 * the extra `path` field OpenFork adds, so the canonical body decodes cleanly
 * and is classified straight from the real version line.
 *
 * EVIDENCE CLASS — READ BEFORE TRUSTING
 *
 * This file is UNIT / CONTRACT scope only. It exercises pure functions and a
 * transcription of T3's decision procedure. It boots no server, spawns no
 * process, and speaks no HTTP or SSE, so it proves NOTHING about real stock-T3
 * process/HTTP/SSE E2E. The process-level facts (`openfork-t3code --version`
 * => `1.15.13`; `/global/health` => 200 `{"healthy":true,"version":"1.15.13"}`;
 * `/api/info` => 404) are owned and proven elsewhere, and the live `/api/info`
 * HTTP invariant belongs to the launcher-version-auth lane. Do not read a green
 * run here as E2E evidence.
 *
 * The oracle below is a TRANSCRIPTION of stock T3's probe logic, read-only from
 * pingdotgg/t3code `origin/main` a21702d0e. T3 is the immutable puzzle piece;
 * it is never modified, and this file deliberately reimplements rather than
 * imports it. The `describe` block that self-checks the oracle against T3's own
 * documented examples exists so that a bad transcription fails loudly here
 * instead of silently inverting every conclusion below it.
 */

const T3_REF = "pingdotgg/t3code origin/main a21702d0e"

/** Reads a repo file relative to this test, used for the real release version line. */
function readRepoFile(relative: string) {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

// ---------------------------------------------------------------------------
// T3 consumer decision oracle (transcribed, read-only, from stock T3)
// ---------------------------------------------------------------------------

type ProbedOpenCode = { readonly generation: "v1" | "v2"; readonly version: string }

/**
 * T3 `packages/shared/src/semver.ts` :: `normalizeSemverVersion` +
 * `parseSemver`. Only `major` is reproduced because that is all the generation
 * decision consumes, but the surrounding acceptance rules are reproduced too:
 * they are what makes near-miss version strings fail closed.
 */
function t3ParseSemver(value: string): { readonly major: number } | null {
  const [main] = value.trim().split("-", 2)
  const segments: string[] = []
  for (const segment of (main ?? "").split(".")) {
    const trimmed = segment.trim()
    if (trimmed.length > 0) segments.push(trimmed)
  }
  while (segments.length > 0 && segments.length < 3) segments.push("0")
  if (segments.length === 0 || segments.length > 3) return null

  const normalized = segments.join(".").replace(/^v/, "")
  const parts = normalized.split(".")
  if (parts.length !== 3) return null
  if (!parts.every((part) => /^\d+$/.test(part))) return null
  const [major, minor, patch] = parts.map((part) => Number.parseInt(part, 10))
  if (![major, minor, patch].every((value) => Number.isInteger(value))) return null
  return { major: major as number }
}

/**
 * T3 `apps/server/src/provider/providerSnapshot.ts` :: `parseGenericCliVersion`.
 *
 * FIRST-MATCH-WINS over the entire stdout. This is a stdout-hygiene contract
 * on OpenFork's side, not merely a T3 implementation detail: any semver-shaped
 * token printed before the real version silently becomes the version T3
 * believes it is running.
 */
const T3_CLI_VERSION_PATTERN = /\bv?(\d+\.\d+\.\d+)\b/
function t3ParseGenericCliVersion(output: string): string | null {
  return output.match(T3_CLI_VERSION_PATTERN)?.[1] ?? null
}

/**
 * T3 `opencodeVersionProbe.ts` :: `probed`.
 *
 * GENERATION FOLLOWS THE SEMVER MAJOR, NEVER THE PATH. A decodable
 * `/api/info` reporting a 1.x version classifies as v1, and a decodable
 * `/global/health` reporting a 2.x version classifies as v2. The endpoint
 * decides only WHICH body is trusted first, never which generation it means.
 */
function t3Probed(version: string | null | undefined): ProbedOpenCode | undefined {
  const major = t3ParseSemver(version ?? "")?.major
  if (!version || major === undefined) return undefined
  return { generation: major >= 2 ? "v2" : "v1", version }
}

/** T3 `opencodeRuntime.ts` :: `MINIMUM_OPENCODE_VERSION`, unchanged at this ref. */
const T3_MINIMUM_OPENCODE_VERSION = "1.14.19"

/**
 * Numeric ordering for the only use here — deciding whether a reported version
 * is too OLD. Deliberately a three-segment, prerelease-insensitive
 * approximation of T3's `compareSemverVersions`, and exact for the plain
 * `x.y.z` strings both OpenFork and the facade actually report.
 */
function t3CompareSemver(left: string, right: string): number {
  const a = fullSegments(left)
  const b = fullSegments(right)
  if (!a || !b) return Number.NaN
  for (let index = 0; index < 3; index += 1) {
    const l = a[index] as number
    const r = b[index] as number
    if (l !== r) return l > r ? 1 : -1
  }
  return 0
}

/** Raw padded `x.y.z` segments, used only by the comparison above. */
function fullSegments(value: string): [number, number, number] | undefined {
  const main = value
    .trim()
    .split("-", 1)[0]!
    .split(".")
    .map((segment) => segment.trim())
  if (main.length === 0 || main.length > 3) return undefined
  while (main.length < 3) main.push("0")
  if (!main.every((segment) => /^\d+$/.test(segment))) return undefined
  const [major, minor, patch] = main.map((segment) => Number.parseInt(segment, 10))
  if (![major, minor, patch].every((part) => Number.isInteger(part))) return undefined
  return [major as number, minor as number, patch as number]
}

/**
 * T3 hard-errors "OpenCode vX is too old" below the minimum, on BOTH the binary
 * and the `serverUrl` branch. So the facade version has TWO independent bounds
 * to respect, and the lower one is the easy one to forget.
 */
function t3IsTooOld(version: string): boolean {
  const order = t3CompareSemver(version, T3_MINIMUM_OPENCODE_VERSION)
  return order < 0
}

type ProbeResponse = {
  readonly status: number
  readonly contentType: string | undefined
  readonly body: string
}

/**
 * T3 decodes probe bodies with `Schema.decodeUnknownOption(Schema.fromJsonString(...))`.
 * That is total-but-lossy: invalid JSON, a missing field, or a wrong field type
 * all collapse to `undefined`, and Effect `Schema.Struct` is non-exact so extra
 * fields are ignored. Reproduced here because it is precisely why a
 * partially-shaped body fails closed instead of half-classifying.
 */
function t3DecodeStruct(body: string, shape: Readonly<Record<string, (raw: unknown) => boolean>>) {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const record = parsed as Record<string, unknown>
  for (const [key, check] of Object.entries(shape)) {
    if (!check(record[key])) return undefined
  }
  return record
}

const t3IsString = (raw: unknown) => typeof raw === "string"
const t3IsInt = (raw: unknown) => typeof raw === "number" && Number.isInteger(raw)
const t3IsLiteralTrue = (raw: unknown) => raw === true

/** T3 `opencodeVersionProbe.ts` :: `classifyOpenCodeProbeResponse`. */
function t3ClassifyProbeResponse(
  path: "/api/info" | "/global/health",
  response: ProbeResponse,
): ProbedOpenCode | "unauthorized" | undefined {
  if (response.status === 401) return "unauthorized"
  const mediaType = response.contentType?.split(";")[0]?.trim().toLowerCase()
  if (response.status !== 200 || mediaType !== "application/json") return undefined
  const decoded =
    path === "/api/info"
      ? t3DecodeStruct(response.body, { version: t3IsString, pid: t3IsInt })
      : t3DecodeStruct(response.body, { healthy: t3IsLiteralTrue, version: t3IsString })
  const version = decoded?.version
  return t3Probed(typeof version === "string" ? version : undefined)
}

/**
 * T3 `opencodeVersionProbe.ts` :: `probeOpenCodeServer` probe loop.
 *
 * Two behaviours matter and both are easy to get wrong:
 *  - a 401 on the FIRST path short-circuits, so `/global/health` is never
 *    consulted and no version is ever disclosed on a rejected password;
 *  - a body that merely fails to decode falls THROUGH to the next path rather
 *    than failing, so only the last exhaustion is an error.
 */
type ServerProbeOutcome =
  | { readonly kind: "identified"; readonly probed: ProbedOpenCode }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unidentified" }

function t3ProbeServer(responses: {
  readonly "/api/info": ProbeResponse
  readonly "/global/health": ProbeResponse
}): ServerProbeOutcome {
  for (const path of ["/api/info", "/global/health"] as const) {
    const result = t3ClassifyProbeResponse(path, responses[path])
    if (result === "unauthorized") return { kind: "unauthorized" }
    if (result !== undefined) return { kind: "identified", probed: result }
  }
  return { kind: "unidentified" }
}

/** The `/global/health` body OpenFork actually serves under the T3 profile. */
function healthResponse(version: string): ProbeResponse {
  return {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ healthy: true, version }),
  }
}

// ---------------------------------------------------------------------------
// The oracle is only trustworthy if it reproduces T3's own documented examples
// ---------------------------------------------------------------------------

describe(`T3 negotiation oracle reproduces stock T3 behaviour (${T3_REF})`, () => {
  test("classifies the two documented generations from each endpoint", () => {
    // T3's own comment: "2.x answers /api/info and 1.x answers /global/health."
    expect(
      t3ClassifyProbeResponse("/api/info", {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: "2.0.18", pid: 4242 }),
      }),
    ).toEqual({ generation: "v2", version: "2.0.18" })

    expect(
      t3ClassifyProbeResponse("/global/health", healthResponse("1.15.13")),
    ).toEqual({ generation: "v1", version: "1.15.13" })
  })

  test("classifies both documented CLI version spellings", () => {
    // T3: "opencode --version prints 1.18.32 on 1.x and opencode v2.0.18 on 2.x".
    expect(t3Probed(t3ParseGenericCliVersion("1.18.32\n"))).toEqual({
      generation: "v1",
      version: "1.18.32",
    })
    expect(t3Probed(t3ParseGenericCliVersion("opencode v2.0.18\n"))).toEqual({
      generation: "v2",
      version: "2.0.18",
    })
  })

  test("generation follows the semver major, not the endpoint", () => {
    // Guards the over-strong claim that circulated earlier. It is NOT "a
    // 200-JSON /api/info means v2": a decodable /api/info reporting 1.x is v1,
    // and a decodable /global/health reporting 2.x is v2.
    expect(
      t3ClassifyProbeResponse("/api/info", {
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ version: "1.15.13", pid: 1 }),
      }),
    ).toEqual({ generation: "v1", version: "1.15.13" })
    expect(t3ClassifyProbeResponse("/global/health", healthResponse("2.0.18"))).toEqual({
      generation: "v2",
      version: "2.0.18",
    })
  })

  test("treats a rejected password as revealing nothing about the version", () => {
    // T3: "Both versions answer a wrong password with a 401 on either path, so
    // a 401 says nothing about the version."
    expect(t3ClassifyProbeResponse("/api/info", { status: 401, contentType: undefined, body: "" })).toBe(
      "unauthorized",
    )
    expect(
      t3ProbeServer({
        "/api/info": { status: 401, contentType: undefined, body: "" },
        // Even a body that WOULD identify as v2 must not be reached.
        "/global/health": healthResponse("2.0.0"),
      }),
    ).toEqual({ kind: "unauthorized" })
  })

  test("ignores a 200 whose body is not JSON media, per T3's HTML-collision rule", () => {
    // T3: "Each serves its web UI's HTML with a 200 on the other's path, so
    // only a JSON body counts."
    expect(
      t3ClassifyProbeResponse("/api/info", {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: JSON.stringify({ version: "2.0.18", pid: 1 }),
      }),
    ).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The load-bearing invariant: OpenFork's presented identity classifies as v1
// ---------------------------------------------------------------------------

describe("OpenFork's presented identity must classify as v1 under stock T3", () => {
  const PROFILE_ON = { [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE }

  test("the T3-profile version is exactly the audited 1.15.13 contract version", () => {
    const reported = localClientReportedVersion(InstallationVersion, PROFILE_ON)
    expect(reported).toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
    expect(t3Probed(reported)).toEqual({ generation: "v1", version: "1.15.13" })
  })

  test("REGRESSION GUARD: the CANONICAL reported version must never classify as v2", () => {
    // THE HAZARD. `/global/health` serves this value on the canonical branch
    // too, and T3 classifies straight from the semver major. Nothing else in the
    // codebase constrains OpenFork's own version line against T3's
    // `major >= 2` rule, so an ordinary 2.0.0 release would silently
    // renegotiate every `serverUrl` deployment onto the v2 bridge with no route
    // added, no error naming the cause, and no other test failing.
    //
    // Asserted as "never v2" rather than "is v1" on purpose: a canonical build
    // reporting something unidentifiable also satisfies this, and it still must
    // not be misread as v2.
    const canonical = localClientReportedVersion(InstallationVersion, {})
    expect(
      t3Probed(canonical)?.generation,
      `canonical /global/health reports ${JSON.stringify(canonical)}; stock T3 reads major >= 2 as v2`,
    ).not.toBe("v2")
  })

  test("the real release-build version line is still classified v1", () => {
    // The test environment is NOT a release build (see the dev-build case), so
    // this is the assertion that actually covers the shipped path: run the same
    // rule over the version line that gets stamped into a bundle.
    const match = readRepoFile("../../package.json").match(/"version":\s*"([^"]+)"/)
    expect(match, "packages/opencode/package.json must carry a version line").not.toBeNull()
    const version = match![1]!
    expect(t3Probed(version)?.generation).toBe("v1")
    expect(t3IsTooOld(version)).toBe(false)
  })

  test("an unbundled build is rejected LOUDLY rather than silently misclassified", () => {
    // FINDING. `InstallationVersion` is `OPENCODE_VERSION ?? "local"` and the
    // define is absent outside a bundled build, so the canonical surface reports
    // `version: "local"`, which T3 cannot parse. Two consequences worth pinning
    // instead of discovering in production:
    //  1. The T3 profile is MANDATORY for T3, not an optimisation — it is the
    //     only thing substituting an identifiable version.
    //  2. Losing the profile fails LOUDLY ("the server did not identify itself
    //     as OpenCode"), which is the safe direction: a dev build cannot silently
    //     renegotiate onto v2.
    expect(InstallationVersion).toBe("local")
    expect(t3Probed("local")).toBeUndefined()
    expect(
      t3ProbeServer({
        "/api/info": { status: 404, contentType: "application/json", body: `{"error":"Not Found"}` },
        "/global/health": healthResponse("local"),
      }),
    ).toEqual({ kind: "unidentified" })
  })

  test("the profile is what pins the version, and it is the only identifiable answer", () => {
    const canonical = localClientReportedVersion(InstallationVersion, {})
    const profiled = localClientReportedVersion(InstallationVersion, PROFILE_ON)
    expect(canonical).not.toBe(profiled)
    expect(t3Probed(canonical)).toBeUndefined()
    expect(t3Probed(profiled)?.generation).toBe("v1")
  })

  test("the facade version respects BOTH bounds: new enough, and still major 1", () => {
    // T3 rejects anything below 1.14.19 as "too old" and reads anything at or
    // above 2.0.0 as the v2 generation. The facade must sit in the window
    // [1.14.19, 2.0.0). Both edges are release traps — lowering the facade
    // version trips the minimum, raising it past 2.0.0 flips the generation — so
    // they are asserted together and neither can move alone.
    const facade = localClientReportedVersion(InstallationVersion, PROFILE_ON)
    expect(
      t3IsTooOld(facade),
      `facade version ${facade} is below stock T3's ${T3_MINIMUM_OPENCODE_VERSION} minimum`,
    ).toBe(false)
    expect(t3Probed(facade)?.generation).toBe("v1")
    expect(t3IsTooOld(T3_MINIMUM_OPENCODE_VERSION)).toBe(false)
    expect(t3IsTooOld("1.14.18")).toBe(true)
  })

  test("a full probe loop against OpenFork's served bodies identifies v1", () => {
    // `/api/info` is deliberately absent (404), which is the load-bearing half
    // of the signal; the live HTTP assertion of that absence is owned by the
    // launcher-version-auth lane and is NOT duplicated here.
    const outcome = t3ProbeServer({
      "/api/info": { status: 404, contentType: "application/json", body: JSON.stringify({ error: "Not Found" }) },
      "/global/health": healthResponse(localClientReportedVersion(InstallationVersion, PROFILE_ON)),
    })
    expect(outcome).toEqual({ kind: "identified", probed: { generation: "v1", version: "1.15.13" } })
  })
})

// ---------------------------------------------------------------------------
// Adversarial mutation matrix — everything here must fail CLOSED, never v2
// ---------------------------------------------------------------------------

describe("malformed and near-miss probe bodies fail closed instead of misclassifying", () => {
  const NOT_V2: ReadonlyArray<readonly [string, ProbeResponse]> = [
    // Missing required field.
    ["health body with no version", { status: 200, contentType: "application/json", body: `{"healthy":true}` }],
    [
      "health body with no healthy flag",
      { status: 200, contentType: "application/json", body: `{"version":"1.15.13"}` },
    ],
    // Wrong field type: `healthy` is Schema.Literal(true), not a truthy string.
    [
      "health body with stringly-typed healthy",
      { status: 200, contentType: "application/json", body: `{"healthy":"true","version":"1.15.13"}` },
    ],
    // Degraded-but-200 must not be read as a healthy identification.
    [
      "health body reporting healthy:false",
      { status: 200, contentType: "application/json", body: `{"healthy":false,"version":"1.15.13"}` },
    ],
    // Unparseable JSON.
    ["health body that is not JSON", { status: 200, contentType: "application/json", body: "not json" }],
    // Non-JSON media type.
    [
      "valid JSON served as text/plain",
      { status: 200, contentType: "text/plain", body: `{"healthy":true,"version":"2.0.0"}` },
    ],
    // Near-miss version strings that must not silently reach a generation.
    [
      "unparseable version string",
      { status: 200, contentType: "application/json", body: `{"healthy":true,"version":"local"}` },
    ],
    [
      "empty version string",
      { status: 200, contentType: "application/json", body: `{"healthy":true,"version":""}` },
    ],
  ]

  test.each(NOT_V2)("health probe does not classify: %s", (_label: string, response: ProbeResponse) => {
    expect(t3ClassifyProbeResponse("/global/health", response)).toBeUndefined()
  })

  test.each([
    ["no pid", `{"version":"2.0.18"}`],
    ["stringly-typed pid", `{"version":"2.0.18","pid":"4242"}`],
    ["fractional pid", `{"version":"2.0.18","pid":1.5}`],
  ])("/api/info with %s cannot identify as v2", (_label: string, body: string) => {
    // A half-shaped `/api/info` is the most dangerous kind of near miss: it is
    // the endpoint T3 checks FIRST, so anything that slips through here wins
    // before `/global/health` is ever consulted.
    expect(
      t3ClassifyProbeResponse("/api/info", { status: 200, contentType: "application/json", body }),
    ).toBeUndefined()
  })

  test("a charset parameter does not hide a JSON identification", () => {
    // Guards the OTHER direction: OpenFork must keep emitting a real JSON
    // content type, otherwise T3 fails closed with "the server did not identify
    // itself as OpenCode" even though the payload is correct.
    expect(
      t3ClassifyProbeResponse("/global/health", {
        status: 200,
        contentType: "application/json; charset=utf-8",
        body: `{"healthy":true,"version":"1.15.13"}`,
      }),
    ).toEqual({ generation: "v1", version: "1.15.13" })
  })

  test("exhausting both paths is an explicit unidentified failure, not a guess", () => {
    expect(
      t3ProbeServer({
        "/api/info": { status: 404, contentType: "application/json", body: `{"error":"Not Found"}` },
        "/global/health": { status: 200, contentType: "text/html", body: "<html></html>" },
      }),
    ).toEqual({ kind: "unidentified" })
  })
})

// ---------------------------------------------------------------------------
// CLI stdout hygiene: first semver-shaped token wins
// ---------------------------------------------------------------------------

describe("T3 CLI version probe is first-match-wins, so stdout must stay clean", () => {
  const PROFILE_ON = { [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE }

  test("a stray banner silently hijacks the detected version", () => {
    // This test documents the TRAP rather than OpenFork behavior: it proves the
    // hazard is real and would be invisible from T3's side.
    expect(t3Probed(t3ParseGenericCliVersion("Upgrading opencode 2.0.0\n1.15.13\n"))).toEqual({
      generation: "v2",
      version: "2.0.0",
    })
  })

  test("the facade's own version output is a single bare 1.x semver token", () => {
    // The launcher emits this verbatim on stdout, so the value itself must not
    // be able to carry a second, hijacking token.
    const reported = localClientReportedVersion(InstallationVersion, PROFILE_ON)
    const matches = reported.match(new RegExp(T3_CLI_VERSION_PATTERN.source, "g")) ?? []
    expect(matches).toEqual(["1.15.13"])
    expect(t3Probed(t3ParseGenericCliVersion(reported))?.generation).toBe("v1")
  })
})

// ---------------------------------------------------------------------------
// Unknown / future model-identity tokens must fail closed
// ---------------------------------------------------------------------------

describe("unknown or malformed account-model tokens fail closed to identity", () => {
  const PROFILE_ON = { [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE }
  const VALID = t3CodeAccountModelID("claude-sonnet", "opencode-account:abc123")

  test("a well-formed alias still resolves, so the negatives below are meaningful", () => {
    expect(canonicalT3CodeModelRef({ providerID: "anthropic", modelID: VALID }, PROFILE_ON)).toEqual({
      providerID: "anthropic",
      modelID: "claude-sonnet",
      accountID: "opencode-account:abc123",
    })
  })

  const UNSPLITTABLE: ReadonlyArray<readonly [string, string]> = [
    ["no marker at all", "claude-sonnet"],
    ["empty token", "claude-sonnet@ofacct:"],
    ["non-base64url token", "claude-sonnet@ofacct:not*valid*base64"],
    ["token with an illegal character", "claude-sonnet@ofacct:abc+def"],
    [
      "decoded payload with an unknown namespace",
      `claude-sonnet@ofacct:${Buffer.from("some-other-namespace:abc", "utf8").toString("base64url")}`,
    ],
    [
      "account id beyond the 256 character bound",
      `claude-sonnet@ofacct:${Buffer.from(`openfork-t3code-account-v1:${"a".repeat(257)}`, "utf8").toString("base64url")}`,
    ],
    [
      "account id containing a control character",
      `claude-sonnet@ofacct:${Buffer.from("openfork-t3code-account-v1:bad id", "utf8").toString("base64url")}`,
    ],
  ]

  test.each(UNSPLITTABLE)("leaves %s untouched rather than half-splitting it", (_label: string, modelID: string) => {
    // The contract is identity, NOT a throw and NOT a partial projection. An
    // unrecognised token degrades to a literal model lookup, which T3 reports as
    // model-not-found — visible, but with the real cause hidden.
    expect(canonicalT3CodeModelRef({ providerID: "anthropic", modelID }, PROFILE_ON)).toEqual({
      providerID: "anthropic",
      modelID,
    })
  })

  test("an already-qualified ref is never re-split", () => {
    expect(
      canonicalT3CodeModelRef(
        { providerID: "anthropic", modelID: "claude-sonnet", accountID: "acct-1" },
        PROFILE_ON,
      ),
    ).toEqual({ providerID: "anthropic", modelID: "claude-sonnet", accountID: "acct-1" })
  })

  test("slugs that are not provider/model pairs stay identity instead of throwing", () => {
    for (const slug of ["claude-sonnet", "anthropic/", "/claude-sonnet", ""]) {
      expect(canonicalT3CodeModelSlug(slug, PROFILE_ON)).toEqual({ slug })
    }
  })

  test("outside the profile a valid alias is left strictly untouched", () => {
    // Misclassification in the OTHER direction: a stray profile value must not
    // be able to turn ordinary canonical OpenFork model ids into account refs.
    expect(canonicalT3CodeModelRef({ providerID: "anthropic", modelID: VALID }, {})).toEqual({
      providerID: "anthropic",
      modelID: VALID,
    })
  })
})

// ---------------------------------------------------------------------------
// Unknown session-status variants: the schema is CLOSED, so pin it that way
// ---------------------------------------------------------------------------

describe("session-status variants are a closed set, keeping T3's no-default switch unreachable", () => {
  // WHY THIS IS PINNED AS A SEALED SET rather than as tolerance.
  //
  // T3's v1 adapter switches on `event.properties.status.type` for
  // busy/retry/idle with NO `default` branch. An unknown variant therefore
  // matches neither the busy nor the idle arm, so the turn is never finalized
  // and the session reads as STILL RUNNING forever. That is fail-OPEN in the
  // dangerous direction: a hang, not a wrong value, and with no error anywhere.
  //
  // That path is currently UNREACHABLE because `SessionStatusEvent.Info` is a
  // closed `Schema.Union` of three literal structs. So the honest negative test
  // is not "an unknown variant degrades gracefully" — it cannot be constructed.
  // The correct pin is that the set stays closed, which turns a future 4th
  // variant from a silent latent hazard into a loud, reviewed source change.
  const KNOWN = [
    { type: "idle" },
    { type: "busy" },
    { type: "retry", attempt: 1, message: "retrying", next: 0 },
  ] as const

  test.each([...KNOWN])("accepts the known variant %o", (status: unknown) => {
    expect(Schema.is(SessionStatusEvent.Info)(status)).toBe(true)
  })

  const NOT_CONSTRUCTIBLE: ReadonlyArray<readonly [string, unknown]> = [
    ["an unknown variant name", { type: "cancelled" }],
    ["a plausible future pause variant", { type: "paused" }],
    ["a plausible future waiting variant", { type: "waiting" }],
    ["a plausible future streaming variant", { type: "streaming" }],
    ["no type at all", {}],
    ["a wrong-typed type", { type: 1 }],
    ["retry missing its required fields", { type: "retry" }],
    ["retry with a string attempt", { type: "retry", attempt: "1", message: "m", next: 0 }],
  ]

  test.each(NOT_CONSTRUCTIBLE)("cannot construct %s", (_label: string, status: unknown) => {
    // Each of these would be a no-default fall-through in T3 if it ever became
    // constructible. Naming the specific near-misses makes the tripwire useful
    // rather than decorative.
    expect(Schema.is(SessionStatusEvent.Info)(status)).toBe(false)
  })

  test("the three known variants are the ONLY ones the schema admits", () => {
    // Belt-and-braces sweep: any literal type string outside the closed union is
    // rejected. Keeps the seal honest if the union is ever rewritten as
    // `Schema.String`-shaped or widened for forwards compatibility.
    for (const candidate of ["idle", "busy", "retry", "cancelled", "paused", "waiting", "error", ""]) {
      const constructible = Schema.is(SessionStatusEvent.Info)({ type: candidate })
      const expected = (["idle", "busy", "retry"] as const).includes(candidate as never)
      if (candidate === "retry") continue // needs its own required fields
      expect(constructible, `status variant ${JSON.stringify(candidate)}`).toBe(expected)
    }
  })
})

// ---------------------------------------------------------------------------
// Malformed / empty credentials
// ---------------------------------------------------------------------------

describe("empty and whitespace passwords are distinguished, never matched as equal", () => {
  const config = (password: string | undefined, username = "opencode") => ({
    password: password === undefined ? Option.none<string>() : Option.some(password),
    username,
    publicUrl: "",
  })

  test("an absent or empty password means auth is not required", () => {
    expect(ServerAuth.required(config(undefined))).toBe(false)
    expect(ServerAuth.required(config(""))).toBe(false)
  })

  test("a whitespace-only password is still a real, enforced password", () => {
    // Guards against a future "trim then treat as unset" convenience, which
    // would silently downgrade an enforced server to an open one.
    expect(ServerAuth.required(config("   "))).toBe(true)
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("   ") }, config("   "))).toBe(
      true,
    )
    expect(ServerAuth.authorized({ username: "opencode", password: Redacted.make("") }, config("   "))).toBe(
      false,
    )
  })

  test("authorization requires the exact username, not just the password", () => {
    const configured = config("secret")
    expect(
      ServerAuth.authorized({ username: "opencode", password: Redacted.make("secret") }, configured),
    ).toBe(true)
    expect(ServerAuth.authorized({ username: "OpenCode", password: Redacted.make("secret") }, configured)).toBe(
      false,
    )
    expect(ServerAuth.authorized({ username: "root", password: Redacted.make("secret") }, configured)).toBe(false)
  })

  test("no configured password can never authorize any presented credential", () => {
    const unsecured = config(undefined)
    for (const password of ["", "secret", "anything"]) {
      expect(
        ServerAuth.authorized({ username: "opencode", password: Redacted.make(password) }, unsecured),
      ).toBe(false)
    }
  })
})
