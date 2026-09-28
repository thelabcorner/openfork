import { describe, expect, test } from "bun:test"
import * as model from "./wakatime-model"
import { cliPath, cliSource, connectionState, type WakaTimeStatusView } from "./wakatime-model"

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

  test("the model exposes no credential or persistence surface", () => {
    // The panel must not grow a key draft, a flush control, or queue telemetry:
    // Core publishes none of those, so there is nothing here to render.
    expect(Object.keys(model).sort()).toEqual(["cliPath", "cliSource", "connectionState"])
  })
})
