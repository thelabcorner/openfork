/**
 * Verbatim transcription of the stock latest-T3 generation probe.
 *
 * SOURCE OF TRUTH (T3 is read-only; nothing in this file was copied by editing T3):
 *   pingdotgg/t3code @ origin/main a21702d0e58ad20263dc965d84472bb6d7eb38c8
 *   apps/server/src/provider/opencodeVersionProbe.ts
 *   apps/server/src/provider/providerSnapshot.ts      (parseGenericCliVersion)
 *   packages/shared/src/semver.ts                     (parseSemver / normalizeSemverVersion)
 *   apps/server/src/provider/opencodeRuntime.ts        (MINIMUM_OPENCODE_VERSION)
 *
 * Every function below is a direct transcription, not a paraphrase, because this
 * file is the DECISION LOGIC that decides whether latest T3 drives OpenFork down
 * the retained v1 path or the v2 path. If T3 changes its classifier, this file is
 * what must change with it — that is the whole reason it exists instead of the
 * test asserting the answer directly.
 *
 * The harness that consumes this module supplies the real process and the real
 * HTTP responses; nothing here performs I/O.
 */

import { Buffer } from "node:buffer"

/** apps/server/src/provider/opencodeRuntime.ts: `export const MINIMUM_OPENCODE_VERSION` */
export const MINIMUM_OPENCODE_VERSION = "1.14.19"

/** packages/shared/src/semver.ts: SEMVER_NUMBER_SEGMENT */
const SEMVER_NUMBER_SEGMENT = /^\d+$/

/** packages/shared/src/semver.ts: normalizeSemverVersion (trim, pad to 3, strip prerelease) */
export function normalizeSemverVersion(version: string): string {
  const [main, prerelease] = version.trim().split("-", 2)
  const segments: string[] = []
  for (const segment of (main ?? "").split(".")) {
    const trimmed = segment.trim()
    if (trimmed.length > 0) {
      segments.push(trimmed)
    }
  }
  while (segments.length > 0 && segments.length < 3) {
    segments.push("0")
  }
  return prerelease ? `${segments.join(".")}-${prerelease}` : segments.join(".")
}

/**
 * packages/shared/src/semver.ts: parseSemver, narrowed to the fields `probed`
 * actually consumes. Returns null exactly where T3's parser returns null.
 */
export function parseSemver(value: string): { major: number; minor: number; patch: number } | null {
  const normalized = normalizeSemverVersion(value).replace(/^v/, "")
  const [main = ""] = normalized.split("-", 2)
  const segments = main.split(".")
  if (segments.length !== 3) return null
  const [majorSegment, minorSegment, patchSegment] = segments
  if (majorSegment === undefined || minorSegment === undefined || patchSegment === undefined) {
    return null
  }
  if (
    !SEMVER_NUMBER_SEGMENT.test(majorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(minorSegment) ||
    !SEMVER_NUMBER_SEGMENT.test(patchSegment)
  ) {
    return null
  }
  const major = Number.parseInt(majorSegment, 10)
  const minor = Number.parseInt(minorSegment, 10)
  const patch = Number.parseInt(patchSegment, 10)
  if (![major, minor, patch].every(Number.isInteger)) return null
  return { major, minor, patch }
}

/**
 * apps/server/src/provider/providerSnapshot.ts:
 *   "Return the first semantic version found in CLI output, or null. Accepts a
 *    leading "v" (for example `opencode v2.0.3`)."
 */
export function parseGenericCliVersion(output: string): string | null {
  const match = output.match(/\bv?(\d+\.\d+\.\d+)\b/)
  return match?.[1] ?? null
}

export interface ProbedOpenCode {
  readonly generation: "v1" | "v2"
  readonly version: string
}

/** opencodeVersionProbe.ts: `probed` — major >= 2 selects v2, anything parseable selects v1. */
function probed(version: string | null | undefined): ProbedOpenCode | undefined {
  const major = parseSemver(version ?? "")?.major
  if (!version || major === undefined) return undefined
  return { generation: major >= 2 ? "v2" : "v1", version }
}

/**
 * opencodeVersionProbe.ts: `classifyOpenCodeCliVersion`.
 * `opencode --version` prints `1.18.32` on 1.x and `opencode v2.0.18` on 2.x.
 * This is the LOCAL BINARY probe branch.
 */
export function classifyOpenCodeCliVersion(output: string): ProbedOpenCode | undefined {
  return probed(parseGenericCliVersion(output))
}

/** The only value `/api/info` will decode: T3 requires BOTH fields to reject unrelated JSON. */
function decodeApiInfo(body: string): { version: string; pid: number } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (typeof record["version"] !== "string") return undefined
  if (typeof record["pid"] !== "number" || !Number.isInteger(record["pid"])) return undefined
  return { version: record["version"], pid: record["pid"] }
}

/** The only value `/global/health` will decode: `healthy` must be the literal true. */
function decodeGlobalHealth(body: string): { healthy: true; version: string } | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  if (record["healthy"] !== true) return undefined
  if (typeof record["version"] !== "string") return undefined
  return { healthy: true, version: record["version"] }
}

/**
 * opencodeVersionProbe.ts: `classifyOpenCodeProbeResponse`.
 *
 * This is the SERVER (external serverUrl) probe branch, and it carries the single
 * most load-bearing fact in the whole dual-generation compatibility story:
 *
 *   "2.x answers `/api/info` and 1.x answers `/global/health`. Each serves its web
 *    UI's HTML with a 200 on the other's path, so only a JSON body counts. Both
 *    versions answer a wrong password with a 401 on either path, so a 401 says
 *    nothing about the version."
 *
 * Note precisely what decides the generation: the PATH selects which decoder
 * runs, and the DECODED VERSION's major selects v1 vs v2. The paths are not
 * themselves generation signals —
 *   `/api/info` 200 JSON {version:"1.15.13",pid:N}          => v1
 *   `/api/info` 200 JSON {version:"2.0.18", pid:N}          => v2
 *   `/global/health` 200 JSON {healthy:true,version:"2.0.18"} => v2
 *   404, or 200 without `application/json`                  => fall through
 *   401                                                     => "unauthorized"
 *
 * Consequence for OpenFork: the flip condition is "a decodable version with
 * major >= 2 on the FIRST-probed path", not "an /api/info route exists".
 * OpenFork therefore keeps `/api/info` absent on purpose — a deliberate
 * conservative facade invariant, so that if a future or native OpenFork release
 * ever reports a real >= 2 version, that version is never volunteered on the
 * path T3 probes first. An absent `/api/info` is therefore the desired steady
 * state, and the invariant is stated in those terms rather than as "a 200 JSON
 * /api/info would flip everything".
 */
export function classifyOpenCodeProbeResponse(
  path: "/api/info" | "/global/health",
  response: {
    readonly status: number
    readonly contentType: string | undefined
    readonly body: string
  },
): ProbedOpenCode | "unauthorized" | undefined {
  if (response.status === 401) return "unauthorized"
  const mediaType = response.contentType?.split(";")[0]?.trim().toLowerCase()
  if (response.status !== 200 || mediaType !== "application/json") return undefined
  const version =
    path === "/api/info"
      ? decodeApiInfo(response.body)?.version
      : decodeGlobalHealth(response.body)?.version
  return probed(version)
}

// ---------------------------------------------------------------------------
// THE SERVER-PROBE LOOP.
//
// CORRECTION (explicit, and load-bearing): this module previously transcribed
// only `classifyOpenCodeProbeResponse`, which is a SINGLE-PATH function. It has
// no loop, no "next path", and no terminal outcome. A test that called it with a
// 404 and asserted `undefined` was therefore proving only "this one path
// identified nothing" — while its NAME claimed the probe "falls through to the
// next probe path". That fall-through is real behaviour, but it lives in the
// `for` loop of `probeOpenCodeServer`, not in the per-path classifier.
//
// The gap mattered because the fall-through IS the v1 mechanism: OpenFork's
// `/api/info` is a 404, so the loop must advance to `/global/health` and return
// v1 from there. Asserting only the per-path `undefined` left that end-to-end
// consequence unpinned, and an incorrect loop would still have passed. The three
// functions below transcribe the loop, so the consequence is now assertable.
// ---------------------------------------------------------------------------

export type ProbePath = "/api/info" | "/global/health"

/** opencodeVersionProbe.ts: `for (const path of ["/api/info", "/global/health"] as const)` */
export const SERVER_PROBE_PATHS = [
  "/api/info",
  "/global/health",
] as const satisfies readonly ProbePath[]

/**
 * opencodeVersionProbe.ts `probeOpenCodeServer`:
 *   "UTF-8, as the 1.x SDK client sends it; `HttpClientRequest.basicAuth` uses Latin-1 `btoa`."
 *
 * The header is OMITTED ENTIRELY when the password is empty, which is why an
 * unsecured OpenFork is the reachable fail-OPEN state rather than a 401.
 */
export function probeAuthorizationHeader(serverPassword: string): string | undefined {
  return serverPassword
    ? `Basic ${Buffer.from(`opencode:${serverPassword}`, "utf8").toString("base64")}`
    : undefined
}

/**
 * opencodeVersionProbe.ts `probeOpenCodeServer`, with its own comment:
 *   "A path prefix and query on the configured URL are kept: `/base/?x=1` -> `/base/api/info?x=1`."
 *   const url = new URL(baseUrl)
 *   url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`
 *
 * Assigning `pathname` leaves `search` untouched, which is why the query survives.
 * This is in scope for real deployments: sub-path and reverse-proxy mounts.
 */
export function probeRequestUrl(serverUrl: string, path: ProbePath): string {
  const url = new URL(serverUrl.trim())
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`
  return url.href
}

export type ServerProbeOutcome =
  | { readonly kind: "identified"; readonly probed: ProbedOpenCode; readonly path: ProbePath }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unidentified" }

/**
 * opencodeVersionProbe.ts `probeOpenCodeServer`, the decision half only.
 *
 * Three terminal shapes, all transcribed:
 *   - `"unauthorized"` -> raise "401 Unauthorized: the OpenCode server rejected
 *     the password." and STOP. It never advances to the next path, because both
 *     generations answer a wrong password with 401 on either path, so a 401
 *     carries no version information.
 *   - a `ProbedOpenCode` -> return it immediately, together with the path that
 *     produced it, so a caller can prove WHICH path identified the server.
 *   - neither -> after the loop, raise "The server did not identify itself as
 *     OpenCode." (reported here as `unidentified`).
 *
 * A path absent from `responses` models a request that was never made and is
 * skipped, matching a harness that only observed some of the candidates.
 */
export function probeOpenCodeServerPaths(
  responses: Partial<
    Record<
      ProbePath,
      { readonly status: number; readonly contentType: string | undefined; readonly body: string }
    >
  >,
): ServerProbeOutcome {
  for (const path of SERVER_PROBE_PATHS) {
    const response = responses[path]
    if (response === undefined) continue
    const result = classifyOpenCodeProbeResponse(path, response)
    if (result === "unauthorized") return { kind: "unauthorized" }
    if (result !== undefined) return { kind: "identified", probed: result, path }
  }
  return { kind: "unidentified" }
}

/**
 * opencodeRuntime.ts: `verifyOpenCodeServerVersion` — the gate the spawned/external
 * server must then pass, independent of which probe branch classified it. T3
 * requires a parseable version >= MINIMUM_OPENCODE_VERSION.
 */
export function verifyOpenCodeServerVersion(healthVersion: string): { ok: true } | { ok: false; reason: string } {
  if (parseSemver(healthVersion) === null) {
    return { ok: false, reason: `OpenCode server returned an invalid version: ${healthVersion}` }
  }
  const parsed = parseSemver(healthVersion)!
  const minimum = parseSemver(MINIMUM_OPENCODE_VERSION)!
  const older =
    parsed.major < minimum.major ||
    (parsed.major === minimum.major && parsed.minor < minimum.minor) ||
    (parsed.major === minimum.major &&
      parsed.minor === minimum.minor &&
      parsed.patch < minimum.patch)
  if (older) {
    return { ok: false, reason: `OpenCode v${healthVersion} is too old (needs >= ${MINIMUM_OPENCODE_VERSION})` }
  }
  return { ok: true }
}