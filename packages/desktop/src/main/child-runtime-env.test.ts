import { describe, expect, test } from "bun:test"
import { childRuntimeEnvPatch } from "./child-runtime-env"

describe("childRuntimeEnvPatch", () => {
  test("forces descendant Electron launches into Node mode", () => {
    expect(childRuntimeEnvPatch({ electron: "42.3.3" })).toEqual({
      ELECTRON_RUN_AS_NODE: "1",
    })
  })

  test("does not modify ordinary Node descendants", () => {
    expect(childRuntimeEnvPatch({})).toEqual({})
  })
})
