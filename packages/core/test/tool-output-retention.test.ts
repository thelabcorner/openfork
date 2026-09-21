import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { brotliDecompressSync } from "node:zlib"
import { ToolOutputRetention } from "../src/tool-output-retention"

describe("ToolOutputRetention", () => {
  test("completed-text compression round-trips UTF-8 exactly", async () => {
    const text = "alpha\nβeta ☃\n🙂 snow\n"
    const compressed = await ToolOutputRetention.compressText(text)
    expect(brotliDecompressSync(compressed).toString("utf-8")).toBe(text)
  })

  test("streaming writer preserves ordered chunks in one Brotli target", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openfork-tool-output-"))
    const file = path.join(dir, "stream.br")
    try {
      const writer = ToolOutputRetention.createWriter(file)
      const chunks = ["HEAD\n", "a".repeat(100_000), "\n雪🙂\n", "TAIL"]
      for (const chunk of chunks) await writer.write(chunk)
      await writer.close()
      await writer.close()

      const compressed = await readFile(file)
      expect(brotliDecompressSync(compressed).toString("utf-8")).toBe(chunks.join(""))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("streaming writer rejects writes after close", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openfork-tool-output-"))
    const file = path.join(dir, "closed.br")
    try {
      const writer = ToolOutputRetention.createWriter(file)
      await writer.write("done")
      await writer.close()
      await expect(writer.write("late")).rejects.toThrow("closed")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("streaming writer observes sink creation failures and reports them through close", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openfork-tool-output-"))
    const file = path.join(dir, "missing-parent", "stream.br")
    try {
      const writer = ToolOutputRetention.createWriter(file)
      await writer.write("content").catch(() => {})
      await expect(writer.close()).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
