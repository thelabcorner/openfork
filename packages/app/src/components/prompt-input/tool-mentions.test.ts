import { describe, expect, test } from "bun:test"
import { toToolOptions } from "./tool-mentions"

describe("toToolOptions", () => {
  test("maps catalog items to tool mention options without hardcoding ids", () => {
    expect(
      toToolOptions([
        { id: "github", description: "GitHub operations", exposure: "lazy", source: "registry" },
        { id: "read", description: "Read a file", exposure: "default", source: "registry" },
      ]),
    ).toEqual([
      {
        type: "tool",
        name: "github",
        display: "github",
        description: "GitHub operations",
        exposure: "lazy",
        source: "registry",
      },
      {
        type: "tool",
        name: "read",
        display: "read",
        description: "Read a file",
        exposure: "default",
        source: "registry",
      },
    ])
  })

  test("empty catalog yields no options", () => {
    expect(toToolOptions([])).toEqual([])
  })
})
