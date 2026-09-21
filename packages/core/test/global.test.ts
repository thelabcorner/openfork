import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@opencode-ai/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "openfork"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test("fork-owned XDG roots use the OpenFork namespace", () => {
    expect(path.basename(Global.Path.data)).toBe("openfork")
    expect(path.basename(Global.Path.config)).toBe("openfork")
    expect(path.basename(Global.Path.cache)).toBe("openfork")
    expect(path.basename(Global.Path.state)).toBe("openfork")
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
