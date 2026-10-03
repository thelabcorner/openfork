import { describe, expect, test } from "bun:test"
import { settingsWakaTimeDict } from "./en-settings-wakatime"

const panel = new URL("../components/settings-v2/wakatime.tsx", import.meta.url)
  .pathname.replace(/^\/([A-Za-z]:)/, "$1")

/**
 * What OpenFork itself puts on the wire. `fromCodingActivity` in
 * `packages/core/src/wakatime.ts` projects entity, entity type, category,
 * read/write, time, and a trustworthy `ai_line_changes`; `heartbeatArgs` and
 * `extraHeartbeat` carry the project folder when the producer knows one, and
 * every delivery carries `--plugin` via `pluginIdentifier`, which is OpenFork's
 * own producer bucket plus stable first-party WakaTime integration identity, not
 * anything about the user.
 */
const SUPPLIED = [
  "file or entity path",
  "read",
  "write",
  "time",
  "line changes",
  "project folder",
  "plugin identity",
  "OpenFork version",
] as const

/**
 * What the WakaTime CLI can still derive on its own. The CLI reads the file and
 * the repository around it, so project name, branch, language, and dependencies
 * reach the heartbeat whether or not OpenFork supplies them. The disclosure
 * therefore must NOT promise that they are absent.
 */
const CLI_DERIVED = ["project name", "branch", "language", "dependencies"] as const

/** Content OpenFork genuinely never puts on the wire, independent of the CLI. */
const NEVER_SENT = [
  "prompts",
  "responses",
  "tool output",
  "file contents",
  "model",
  "session",
  "source reference",
  "replay reference",
] as const

/**
 * Core coalesces same-file observations into one `Activity` and delivers a
 * batch as a single CLI invocation (one primary plus extra heartbeats), so
 * activity is not 1:1 with a heartbeat. The disclosure must never imply
 * otherwise in either direction.
 */
const CARDINALITY_CLAIMS = [
  "one heartbeat per",
  "one heartbeat for each",
  "one heartbeat for every",
  "heartbeat per activity",
  "each activity gets",
  "each activity is sent as",
  "a heartbeat for every",
  "a heartbeat for each",
  "one command per",
  "one wakatime command per",
] as const

describe("WakaTime settings copy", () => {
  test("every settings.wakatime key the panel references resolves to a dictionary family", async () => {
    const source = await Bun.file(panel).text()
    const referenced = new Set(source.match(/settings\.wakatime\.[a-zA-Z.]+/g) ?? [])
    expect(referenced.size).toBeGreaterThan(0)

    const unresolved = [...referenced]
      .filter((key) => {
        // A dynamic family (`...status.${connection()}`) resolves at render
        // time, so require the family itself to be populated.
        if (key.endsWith(".")) {
          return !Object.keys(settingsWakaTimeDict).some((defined) => defined.startsWith(key))
        }
        return !(key in settingsWakaTimeDict)
      })
      .sort()

    expect(unresolved).toEqual([])
  })

  test("stale backend handling fails closed and restart is local-sidecar-only", async () => {
    const source = await Bun.file(panel).text()
    expect(source).toContain("const next = parseWakaTimeStatus(value)")
    expect(source).toContain("acceptStatus(response.data)")
    expect(source).toContain('loadError() === "unsupported"')
    expect(source).toContain('platform.platform === "desktop"')
    expect(source).toContain("ServerConnection.builtin(current)")
    expect(source).toContain("platform.restart()")
    expect(source).toContain("didApplyWakaTimeEnabled(next, enabled)")
  })

  test("an enabled unresolved CLI exposes an explicit preparation retry", async () => {
    const source = await Bun.file(panel).text()
    expect(source).toContain('connection() === "missing-cli"')
    expect(source).toContain("setEnabled(true)")
    expect(source).toContain("settings.wakatime.action.prepareCli")
    expect(settingsWakaTimeDict["settings.wakatime.action.prepareCli"]).toBe("Prepare command line")
    expect(settingsWakaTimeDict["settings.wakatime.configuration.cli.unresolved"]).toBe("Command line not prepared")
  })

  test("the dictionary carries no key the panel never renders", async () => {
    const source = await Bun.file(panel).text()
    const referenced = new Set(source.match(/settings\.wakatime\.[a-zA-Z.]+/g) ?? [])
    const orphans = Object.keys(settingsWakaTimeDict)
      .filter((key) => !referenced.has(key) && ![...referenced].some((used) => used.endsWith(".")))
      .sort()

    expect(orphans).toEqual([])
  })

  test("the sent paragraph names every field OpenFork supplies", () => {
    const sent = settingsWakaTimeDict["settings.wakatime.privacy.sent"]
    for (const field of SUPPLIED) expect(sent).toContain(field)
  })

  test("the sent paragraph makes no 1:1 activity-to-heartbeat claim", () => {
    const sent = settingsWakaTimeDict["settings.wakatime.privacy.sent"].toLowerCase()
    for (const claim of CARDINALITY_CLAIMS) expect(sent).not.toContain(claim)
    // No countable "one X per Y" shape may reappear in any phrasing.
    expect(sent).not.toMatch(/\bone\b[^.]*\bper\b/)
    expect(sent).not.toMatch(/\bper\b[^.]*\bone\b/)
    // The neutral scoping stays in place so the paragraph still has a subject.
    expect(sent).toContain("queued coding activity")
  })

  test("the sent paragraph discloses OpenFork's own WakaTime plugin identity", () => {
    const sent = settingsWakaTimeDict["settings.wakatime.privacy.sent"]
    // `--plugin` carries a first-party attribution token plus one stable
    // integration token; carrier-client detail is deliberately not a dimension.
    expect(sent).toContain("plugin identity")
    expect(sent.toLowerCase()).toContain("wakatime plugin")
    expect(sent).toContain("OpenFork version")
    expect(sent).toContain("stable token")
    expect(sent).toContain("OpenFork OXP")
    expect(sent).toContain("OpenFork OFXP")
    expect(sent).toContain("attributed to OpenFork")
    expect(sent).toContain("is not sent as a separate WakaTime attribution dimension")
  })

  test("the disclosed version is OpenFork's own, never the user's model", () => {
    const sent = settingsWakaTimeDict["settings.wakatime.privacy.sent"]
    // Disclosing OpenFork's own version must not leak into a model disclosure.
    expect(sent).not.toMatch(/model version/i)
    expect(sent).not.toMatch(/\bversion of the model\b/i)
    // Model identity stays in the never-sent list.
    const excluded = settingsWakaTimeDict["settings.wakatime.privacy.excluded"].toLowerCase()
    expect(excluded).toMatch(/does not send[^.]*model/)
  })

  test("the sent paragraph discloses the metadata the WakaTime CLI derives for itself", () => {
    const sent = settingsWakaTimeDict["settings.wakatime.privacy.sent"]
    // Attribution matters: these fields come from the CLI, not from OpenFork,
    // and are governed by the user's own WakaTime configuration.
    expect(sent).toContain("WakaTime CLI")
    expect(sent).toContain("WakaTime configuration")
    for (const field of CLI_DERIVED) expect(sent).toContain(field)
  })

  test("the disclosure never claims repository-derived fields are withheld", () => {
    // The old copy asserted OpenFork "does not attach project, branch,
    // language", which is false: the CLI derives them from the file and repo.
    // Keep the never-sent list limited to content OpenFork actually holds.
    const excluded = settingsWakaTimeDict["settings.wakatime.privacy.excluded"].toLowerCase()
    expect(excluded).not.toContain("does not attach")
    for (const field of CLI_DERIVED) expect(excluded).not.toContain(field)
  })

  test("the excluded paragraph names the content OpenFork never sends", () => {
    const excluded = settingsWakaTimeDict["settings.wakatime.privacy.excluded"].toLowerCase()
    expect(excluded).toContain("does not send")
    for (const field of NEVER_SENT) expect(excluded).toContain(field)
  })

  test("the credentials paragraph keeps auth in WakaTime's own configuration", () => {
    const credentials = settingsWakaTimeDict["settings.wakatime.privacy.credentials"]
    expect(credentials).toContain("~/.wakatime.cfg")
    expect(credentials).toContain("WAKATIME_HOME")
    expect(credentials).toContain("WAKATIME_API_KEY")
    expect(credentials.toLowerCase()).toContain("never stores a wakatime credential")
  })

  test("the storage claim covers every non-secret WakaTime state family without exposing project paths", () => {
    const credentials = settingsWakaTimeDict["settings.wakatime.privacy.credentials"]
    const storage = credentials.slice(credentials.indexOf("OpenFork stores"))
    expect(storage).toContain("opt-in")
    expect(storage.toLowerCase()).toContain("non-secret")
    expect(storage.toLowerCase()).toContain("command line")
    expect(storage).toContain("SHA-256 project fingerprints")
    expect(storage).toContain("last-delivery timestamps")
    expect(storage).toContain("does not store raw project paths")
    // Core persists several non-secret operational documents, so "stores only
    // the opt-in" would be a false narrower claim.
    expect(storage).not.toMatch(/\bonly\b/)
  })

  test("an operator-forced effective state is explainable from the toggle error", () => {
    expect(settingsWakaTimeDict["settings.wakatime.error.notApplied"]).toContain("OPENFORK_WAKATIME")
  })
})
