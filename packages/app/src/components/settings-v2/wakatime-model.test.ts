import { describe, expect, test } from "bun:test"
import * as model from "./wakatime-model"
import {
  cliPath,
  cliSource,
  connectionState,
  didApplyWakaTimeEnabled,
  parseWakaTimeStatus,
  type WakaTimeStatusView,
} from "./wakatime-model"

const status = (value: Partial<WakaTimeStatusView> = {}): WakaTimeStatusView => ({
  enabled: false,
  configured: false,
  ...value,
})

describe("wakatime settings view-model", () => {
  test("connection state is derived from the Core status projection only", () => {
    expect(connectionState(undefined)).toBe("disabled")
    expect(connectionState(status())).toBe("disabled")
    // Configured material alone never implies the user opted in.
    expect(connectionState(status({ configured: true, cli: "/usr/bin/wakatime-cli" }))).toBe("disabled")
    expect(connectionState(status({ enabled: true }))).toBe("missing-key")
    expect(connectionState(status({ enabled: true, configured: true }))).toBe("missing-cli")
    expect(connectionState(status({ enabled: true, configured: true, cli: "/usr/bin/wakatime-cli" }))).toBe("ready")
  })

  test("a blank CLI path is treated as unresolved rather than rendered", () => {
    expect(cliPath(undefined)).toBeUndefined()
    expect(cliPath(status())).toBeUndefined()
    expect(cliPath(status({ cli: "" }))).toBeUndefined()
    expect(cliPath(status({ cli: "   " }))).toBeUndefined()
    expect(cliPath(status({ cli: "  /usr/bin/wakatime-cli  " }))).toBe("/usr/bin/wakatime-cli")
    // A source without a resolved path is not a state the panel can report.
    expect(cliSource(status({ source: "system" }))).toBe("system")
    expect(cliSource(status())).toBeUndefined()
  })

  test("an unknown CLI source from a newer server is dropped, not rendered raw", () => {
    expect(cliSource(status({ source: "bundled" as never }))).toBeUndefined()
  })

  test("runtime status decoding rejects stale-route HTML and malformed payloads", () => {
    expect(parseWakaTimeStatus("<!doctype html>")).toBeUndefined()
    expect(parseWakaTimeStatus(null)).toBeUndefined()
    expect(parseWakaTimeStatus([])).toBeUndefined()
    expect(parseWakaTimeStatus({ enabled: true })).toBeUndefined()
    expect(parseWakaTimeStatus({ enabled: true, configured: "yes" })).toBeUndefined()
    expect(parseWakaTimeStatus({ enabled: true, configured: true, cli: 42 })).toBeUndefined()
  })

  test("runtime status decoding accepts the Core projection and sanitizes future source values", () => {
    expect(
      parseWakaTimeStatus({
        enabled: true,
        configured: true,
        cli: " C:/wakatime-cli.exe ",
        source: "system",
        futureField: "ignored",
      }),
    ).toEqual({
      enabled: true,
      configured: true,
      cli: " C:/wakatime-cli.exe ",
      source: "system",
    })

    expect(parseWakaTimeStatus({ enabled: false, configured: true, source: "bundled" })).toEqual({
      enabled: false,
      configured: true,
    })
  })

  test("toggle success follows returned effective state, never requested intent alone", () => {
    expect(didApplyWakaTimeEnabled(status({ enabled: true }), true)).toBe(true)
    expect(didApplyWakaTimeEnabled(status({ enabled: false }), false)).toBe(true)
    expect(didApplyWakaTimeEnabled(status({ enabled: false }), true)).toBe(false)
    expect(didApplyWakaTimeEnabled(status({ enabled: true }), false)).toBe(false)
  })

  test("the model exposes no credential or persistence surface", () => {
    // The panel must not grow a key draft, a flush control, or queue telemetry:
    // Core publishes none of those, so there is nothing here to render.
    expect(Object.keys(model).sort()).toEqual([
      "cliPath",
      "cliSource",
      "connectionState",
      "didApplyWakaTimeEnabled",
      "parseWakaTimeStatus",
    ])
  })
})
