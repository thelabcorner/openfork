import { describe, expect, test } from "bun:test"
import type { Diagnostic as LspDiagnostic } from "vscode-languageserver-types"
import { Diagnostic } from "../../src/lsp/diagnostic"

const sample = (message: string): LspDiagnostic => ({
  range: {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 1 },
  },
  message,
  severity: 1,
  relatedInformation: [{
    location: {
      uri: "file:///workspace/other.ts",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 1 },
      },
    },
    message: "large related payload".repeat(500),
  }],
  data: { nested: "large opaque payload".repeat(500) },
})

describe("LSP diagnostic metadata projection", () => {
  test("persists only changed files and bounds diagnostic count, fields, and bytes", () => {
    const all = {
      "/workspace/changed.ts": Array.from({ length: 300 }, () => sample("x".repeat(10_000))),
      "/workspace/unrelated.ts": [sample("must not be persisted")],
    }

    const projected = Diagnostic.metadataForFiles(["/workspace/changed.ts"], all)
    const serialized = JSON.stringify(projected)
    const values = Object.values(projected).flat()

    expect(Object.keys(projected)).toEqual(["/workspace/changed.ts"])
    expect(values).toHaveLength(20)
    expect(values[0]?.message).toHaveLength(2_000)
    expect(values[0]).not.toHaveProperty("relatedInformation")
    expect(values[0]).not.toHaveProperty("data")
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThanOrEqual(64 * 1024)
  })

  test("deduplicates target paths and omits empty diagnostic rows", () => {
    const all = {
      "/workspace/changed.ts": [sample("one")],
      "/workspace/clean.ts": [],
    }

    expect(Diagnostic.metadataForFiles(["/workspace/changed.ts", "/workspace/changed.ts", "/workspace/clean.ts"], all)).toEqual({
      "/workspace/changed.ts": [{
        range: all["/workspace/changed.ts"][0]!.range,
        message: "one",
        severity: 1,
      }],
    })
  })
})
