import { describe, expect, test } from "bun:test"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Schema } from "effect"
import { OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import {
  T3_CODE_COMPAT_PROFILE,
  T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
  isT3CodeCompatibilityProfile,
  localClientReportedVersion,
  localServerListeningProduct,
} from "../../src/compat/t3code"
import { OpenCodeHttpApi } from "../../src/server/routes/instance/httpapi/api"

/**
 * Generation-negotiation guard for the T3 Code compatibility facade.
 *
 * Latest stock T3 Code picks its OpenCode client generation from a version
 * probe, not from a capability handshake. `opencodeVersionProbe.ts` at T3
 * origin/main a21702d0e decodes a semver major and selects `v2` at major >= 2,
 * `v1` otherwise, on two independent inputs:
 *
 *   1. the CLI: `opencode --version` prints `1.18.32` on 1.x and
 *      `opencode v2.0.18` on 2.x, so both spellings must yield a major; and
 *   2. the server: it walks `/api/info` then `/global/health`, accepts only a
 *      JSON body, and applies the PATH-SPECIFIC decoder to extract a VERSION
 *      string. The generation then follows from that version alone.
 *
 * The path does NOT imply the generation. `/api/info` carrying
 * `{version:"1.15.13",pid:1234}` selects v1; only a decodable `/api/info`
 * reporting major >= 2 selects v2. Requiring both `version` and `pid` on the
 * info shape is what keeps unrelated JSON from being read as a version.
 *
 * Because selection is version-driven, the generation OpenFork is offered is
 * decided entirely by two values: what the wrapper prints for `--version`, and
 * what `/global/health` reports. Nothing else in the facade participates. This
 * suite pins both from one shared expectation.
 *
 * It also pins the ABSENCE of `/api/info`. That absence is a deliberate
 * conservative facade invariant, not a consequence of the selection rule: T3
 * would happily read a 1.x version off `/api/info` if one were served. Keeping
 * the route unserved means the only probe that can identify this wrapper is the
 * health one, so no future route work can start leaking a native OpenFork
 * version (for example a 2.x one) into the facade through the info path.
 *
 * This is contract/unit evidence. It proves the values OpenFork presents and
 * the shapes T3 decodes. It does not run a stock T3 process, and it is not
 * end-to-end evidence for the generation decision. In particular the 401 case
 * below only transcribes the probe's decision table; the real process-level
 * proof that a wrong password hard-fails without falling back belongs to the
 * launcher/version/auth lane.
 *
 * OWNERSHIP — what is deliberately NOT asserted here, so this file does not rot:
 *   - `major < 2` on the reported version, and the bare-semver form, are owned by
 *     test/compat/t3code-version-window.test.ts (:201-204). Asserting the same
 *     property twice guarantees one of them rots when the constant changes.
 *   - Profile-off identity of `isT3CodeCompatibilityProfile` /
 *     `localServerListeningProduct` is owned by
 *     test/compat/canonical-openfork-isolation.test.ts.
 *
 * What is uniquely this file: the probe DECISION TABLE oracle below, the 401
 * hard-fail semantics, the `/api/info` absence guard, the mutual-exclusivity of
 * the two probe inputs, and the canonical-branch tripwire that runs the real
 * native version through T3's own classifier (including the `local` dev
 * sentinel's fail-closed branch, which no other suite exercises).
 */

type Generation = "v1" | "v2"
type Method = "get" | "post" | "patch"
type Spec = {
  readonly paths: Record<string, Partial<Record<Method, unknown>>>
}

const T3_PROFILE_ENV = { OPENFORK_COMPAT_PROFILE: T3_CODE_COMPAT_PROFILE } as const
const CANONICAL_ENV = { OPENFORK_COMPAT_PROFILE: undefined } as const

/**
 * Stand-in native version for the projection tests. It is deliberately NOT the
 * facade version, so the profile cases prove the profile actually overrides the
 * native value instead of passing trivially on a matching input. A synthetic
 * sentinel keeps these tests from implying that any particular number is
 * OpenFork's real product version.
 */
const NATIVE_VERSION_SENTINEL = "native-version-under-test"

/**
 * Transcribed from T3 `opencodeVersionProbe.ts`: `probed()` returns undefined for
 * an absent or unparseable version, otherwise the generation from the major.
 */
function t3Classify(version: string | null | undefined): Generation | undefined {
  const major = semver.parse(version ?? "", { loose: true })?.major
  if (!version || major === undefined) return undefined
  return major >= 2 ? "v2" : "v1"
}

/**
 * Transcribed from T3 `parseGenericCliVersion` usage: the CLI probe recovers a
 * bare version from either spelling before classifying it.
 */
function t3ClassifyCliVersion(stdout: string): Generation | undefined {
  return t3Classify(stdout.match(/\d+\.\d+\.\d+/)?.[0])
}

/** T3 `decodeApiInfo`: the 2.x probe requires version AND pid to reject stray JSON. */
const t3DecodeApiInfo = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String, pid: Schema.Int })),
)

/** T3 `decodeGlobalHealth`: the 1.x probe requires healthy:true AND version. */
const t3DecodeGlobalHealth = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ healthy: Schema.Literal(true), version: Schema.String })),
)

/** One probed response. A path absent from the map answered 404 and is skipped. */
type ProbeResponse = {
  readonly status: number
  readonly contentType?: string
  readonly body?: string
}

/**
 * The probe's decision table. `rejected-password` is T3's hard error, not an
 * unidentified server: a 401 on either candidate path means the password was
 * refused, so the probe stops instead of trying the next path.
 */
type ProbeOutcome = Generation | "rejected-password" | "unidentified"

/**
 * T3's server-side probe: walk the candidate paths in order and stop at the
 * first answer that identifies a generation. `/api/info` is asked first, so it
 * wins whenever its body decodes to a usable version — including a 1.x one.
 */
function t3ProbeServer(
  responses: Readonly<Record<string, ProbeResponse>>,
): ProbeOutcome {
  for (const path of ["/api/info", "/global/health"] as const) {
    const response = responses[path]
    if (response === undefined) continue
    if (response.status === 401) return "rejected-password"
    // T3 requires exactly 200 and exactly application/json. A 2xx other than
    // 200, or a JSON body served under another content type, is not evidence.
    if (response.status !== 200) continue
    if (response.contentType?.split(";")[0]?.trim().toLowerCase() !== "application/json") continue
    const body = response.body
    if (body === undefined) continue
    const version =
      path === "/api/info"
        ? t3DecodeApiInfo(body).pipe((info) => (info._tag === "Some" ? info.value.version : undefined))
        : t3DecodeGlobalHealth(body).pipe((health) =>
            health._tag === "Some" ? health.value.version : undefined,
          )
    const generation = t3Classify(version)
    if (generation !== undefined) return generation
  }
  return "unidentified"
}

const json = (body: unknown): ProbeResponse => ({
  status: 200,
  contentType: "application/json; charset=utf-8",
  body: JSON.stringify(body),
})

describe("T3 Code OpenCode generation negotiation", () => {
  test("the T3 profile projects exactly the audited OpenCode 1.x version", () => {
    expect(isT3CodeCompatibilityProfile(T3_PROFILE_ENV)).toBe(true)
    expect(localClientReportedVersion(NATIVE_VERSION_SENTINEL, T3_PROFILE_ENV)).toBe(
      T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
    )
    // T3 reads the wrapper's stdout, which is the bare version with no product prefix.
    expect(t3ClassifyCliVersion(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)).toBe("v1")
  })

  test("the two probe inputs are mutually exclusive configurations, not conjunctive gates", () => {
    // `probeOpenCodeRuntime` runs the server probe when a serverUrl is
    // configured and the binary `--version` probe otherwise. It never runs both,
    // so proving one input says nothing about the other: a T3-launched process is
    // decided by the CLI projection, while an external-serverUrl deployment is
    // decided by the health envelope. Both are asserted here because both are
    // real configurations, NOT because T3 requires them to agree.
    expect(t3ClassifyCliVersion(localClientReportedVersion(InstallationVersion, T3_PROFILE_ENV))).toBe(
      "v1",
    )
    expect(
      t3ProbeServer({
        "/global/health": json({
          healthy: true,
          version: localClientReportedVersion(InstallationVersion, T3_PROFILE_ENV),
        }),
      }),
    ).toBe("v1")
  })

  test("canonical OpenFork's reported version must not silently select the v2 generation", () => {
    // Durable hazard, flagged by v2-http-contracts and independently checked
    // here: `/global/health` reports localClientReportedVersion(InstallationVersion)
    // (see handlers/global.ts:652), so for an external-serverUrl deployment
    // WITHOUT the T3 profile the value T3 reads is OpenFork's own product
    // version. The generation is only v1 while that major stays below 2, so this
    // is a tripwire: when OpenFork reaches 2.0.0, T3 starts selecting its
    // unexercised v2 client against a v1 API, with no route added and no error
    // naming the cause.
    const reported = localClientReportedVersion(InstallationVersion, CANONICAL_ENV)
    if (semver.parse(reported) === null) {
      // A dev/test build stamps no release version, so the projection is the
      // non-semver "local" sentinel. That fails closed to unidentified, which is
      // safe and is not the hazard this fence guards.
      expect(t3Classify(reported)).toBeUndefined()
      return
    }
    expect(
      t3Classify(reported),
      "canonical OpenFork now reports a major >= 2 on /global/health, so an external serverUrl deployment of T3 would silently negotiate v2. Decide the intended behaviour before shipping this version.",
    ).toBe("v1")
  })

  test("the projected CLI version is what makes the v1 client generation inevitable", () => {
    // T3 selects v2 at major >= 2. Pin both spellings of its own rule so the
    // oracle is shown to discriminate rather than to always answer "v1".
    expect(t3ClassifyCliVersion("opencode v2.0.18")).toBe("v2")
    expect(t3ClassifyCliVersion("1.18.32")).toBe("v1")
    expect(t3ClassifyCliVersion(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)).toBe("v1")
    expect(t3Classify("not-a-version")).toBeUndefined()
  })

  test("the server answers the v1 health probe and leaves the info probe unserved", () => {
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as Spec

    expect(spec.paths["/global/health"]?.get).toBeDefined()
    // Conservative facade invariant, not a rule T3 enforces: T3 would accept a
    // 1.x version from /api/info. Serving it would let a future native version
    // reach the facade through a path T3 asks FIRST, so it stays unserved.
    expect(
      spec.paths["/api/info"]?.get,
      "serving /api/info would let a native version reach the facade through T3's first-probed path",
    ).toBeUndefined()
  })

  test("the health envelope decodes as T3's 1.x shape and reports one shared version", () => {
    // One expectation drives both negotiation inputs, so the CLI projection and
    // the health envelope cannot drift into disagreeing versions.
    const shared = localClientReportedVersion(NATIVE_VERSION_SENTINEL, T3_PROFILE_ENV)

    expect(t3DecodeGlobalHealth(JSON.stringify({ healthy: true, version: shared }))._tag).toBe("Some")
    expect(t3ProbeServer({ "/global/health": json({ healthy: true, version: shared }) })).toBe("v1")
    // The 1.x health body must NOT satisfy the stricter info decoder.
    expect(t3DecodeApiInfo(JSON.stringify({ healthy: true, version: shared }))._tag).toBe("None")
  })

  test("the generation follows the decoded version, not the path that served it", () => {
    const shared = localClientReportedVersion(NATIVE_VERSION_SENTINEL, T3_PROFILE_ENV)

    // An info route reporting a 1.x version still selects v1: the path picks the
    // decoder, and the version picks the generation.
    expect(
      t3ProbeServer({
        "/api/info": json({ version: shared, pid: 1234 }),
        "/global/health": json({ healthy: true, version: shared }),
      }),
    ).toBe("v1")
    // Only a decodable info route reporting major >= 2 selects v2.
    expect(
      t3ProbeServer({
        "/api/info": json({ version: "2.0.18", pid: 1234 }),
        "/global/health": json({ healthy: true, version: shared }),
      }),
    ).toBe("v2")
    // Stray JSON that lacks `pid` cannot be read as a version, so the probe
    // falls through to the health path instead of guessing.
    expect(
      t3ProbeServer({
        "/api/info": json({ version: "2.0.18" }),
        "/global/health": json({ healthy: true, version: shared }),
      }),
    ).toBe("v1")
    // The web UI answers the other generation's path with HTML on a 200, so
    // content type is part of the evidence. A 2xx that is not exactly 200 is not
    // evidence either.
    expect(
      t3ProbeServer({
        "/api/info": { status: 200, contentType: "text/html", body: "<html></html>" },
        "/global/health": json({ healthy: true, version: shared }),
      }),
    ).toBe("v1")
    expect(
      t3ProbeServer({
        "/api/info": { status: 204, contentType: "application/json" },
        "/global/health": json({ healthy: true, version: shared }),
      }),
    ).toBe("v1")
    // A JSON content type without the charset parameter still counts.
    expect(
      t3ProbeServer({
        "/api/info": { status: 200, contentType: "application/json", body: JSON.stringify({ version: "2.0.18", pid: 7 }) },
        "/global/health": json({ healthy: true, version: shared }),
      }),
    ).toBe("v2")
  })

  test("a 401 hard-fails the probe instead of falling through to the next path", () => {
    // Both generations answer a wrong password with 401 on either path, so the
    // probe cannot read it as a version. T3 reports a rejected password as a
    // hard error rather than trying /global/health.
    expect(t3ProbeServer({ "/api/info": { status: 401 } })).toBe("rejected-password")
    expect(t3ProbeServer({ "/global/health": { status: 401 } })).toBe("rejected-password")
    expect(
      t3ProbeServer({
        "/api/info": { status: 401 },
        "/global/health": json({ healthy: true, version: T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION }),
      }),
    ).toBe("rejected-password")
    // With no candidate path identifying the server, and no 401 to report, the
    // probe simply fails to identify it.
    expect(t3ProbeServer({})).toBe("unidentified")
    expect(t3ProbeServer({ "/global/health": { status: 404 } })).toBe("unidentified")
    expect(t3Classify(undefined)).toBeUndefined()
  })

  test("the startup line keeps the compatibility product spelling only under the profile", () => {
    expect(localServerListeningProduct(T3_PROFILE_ENV)).toBe("opencode")
  })

  test("outside the T3 profile OpenFork keeps its native identity", () => {
    expect(isT3CodeCompatibilityProfile(CANONICAL_ENV)).toBe(false)
    expect(localClientReportedVersion(NATIVE_VERSION_SENTINEL, CANONICAL_ENV)).toBe(
      NATIVE_VERSION_SENTINEL,
    )
    expect(localServerListeningProduct(CANONICAL_ENV)).toBe("OpenFork")
  })
})