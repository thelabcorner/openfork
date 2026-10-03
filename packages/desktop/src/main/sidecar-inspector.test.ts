import { describe, expect, test } from "bun:test"
import { sidecarInspectorExecArgv, sidecarInspectorURL } from "./sidecar-inspector"

describe("sidecar inspector exposure", () => {
  test("enables an ephemeral loopback inspector only for unpackaged builds", () => {
    expect(sidecarInspectorExecArgv(false)).toEqual(["--inspect=127.0.0.1:0"])
    expect(sidecarInspectorExecArgv(true)).toEqual([])
  })

  test("publishes only loopback inspector endpoints", () => {
    expect(sidecarInspectorURL("Debugger listening on ws://127.0.0.1:9333/abc")).toBe("ws://127.0.0.1:9333/abc")
    expect(sidecarInspectorURL("Debugger listening on ws://0.0.0.0:9333/abc")).toBeUndefined()
  })
})
