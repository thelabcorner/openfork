import { describe, expect, test } from "bun:test"
import { parseGlobOutput, parseGrepOutput, parseReadWindow, relativizeProjectPath } from "./search-results"

describe("parseReadWindow", () => {
  test("recovers a file window, its line range and its total", () => {
    const output = [
      '<path lines="900">/app/src/a.ts</path>',
      "<type>file</type>",
      "<content>",
      "140: const a = 1",
      "141: const b = 2",
      "",
      "(Showing lines 140-141 of 900. Use offset=142 to continue.)",
      "</content>",
    ].join("\n")
    expect(parseReadWindow(output)).toEqual({
      type: "file",
      path: "/app/src/a.ts",
      text: "const a = 1\nconst b = 2",
      lineStart: 140,
      lineEnd: 141,
      totalLines: 900,
      truncated: true,
    })
  })

  test("a complete file is not reported as truncated", () => {
    const output = [
      '<path lines="2">/a.ts</path>',
      "<type>file</type>",
      "<content>",
      "1: a",
      "2: b",
      "",
      "(End of file - total 2 lines)",
      "</content>",
    ].join("\n")
    expect(parseReadWindow(output)).toMatchObject({ truncated: false, text: "a\nb" })
  })

  test("blank source lines survive the gutter strip", () => {
    const output = ['<path lines="3">/a.ts</path>', "<type>file</type>", "<content>", "1: a", "2:", "3: c", "</content>"].join(
      "\n",
    )
    expect(parseReadWindow(output)).toMatchObject({ text: "a\n\nc" })
  })

  test("indentation is preserved exactly", () => {
    const output = ['<path lines="1">/a.ts</path>', "<type>file</type>", "<content>", "1:     indented", "</content>"].join(
      "\n",
    )
    expect(parseReadWindow(output)).toMatchObject({ text: "    indented" })
  })

  test("recovers a directory listing", () => {
    const output = [
      '<path entries="3">/app/src</path>',
      "<type>directory</type>",
      "<entries>",
      "components/",
      "index.ts",
      "(3 entries.)",
      "</entries>",
    ].join("\n")
    expect(parseReadWindow(output)).toEqual({
      type: "directory",
      path: "/app/src",
      entries: ["components/", "index.ts"],
      totalEntries: 3,
      truncated: false,
    })
  })

  test("a paged directory listing is truncated", () => {
    const output = [
      '<path entries="40">/app/src</path>',
      "<type>directory</type>",
      "<entries>",
      "a.ts",
      "(Showing 1 of 40 entries. Use offset to continue.)",
      "</entries>",
    ].join("\n")
    expect(parseReadWindow(output)).toMatchObject({ truncated: true, entries: ["a.ts"] })
  })

  test("unrelated output is rejected rather than guessed at", () => {
    expect(parseReadWindow("just some text")).toBeUndefined()
    expect(parseReadWindow('{"json":true}')).toBeUndefined()
    expect(parseReadWindow("<path>/a.ts</path>\n<type>file</type>")).toBeUndefined()
  })
})

describe("parseGrepOutput", () => {
  test("groups matches by file", () => {
    const output = ["Found 2 matches", "a.ts:", "  Line 1: alpha", "", "b.ts:", "  Line 9: beta"].join("\n")
    expect(parseGrepOutput(output)).toEqual({
      total: 2,
      truncated: false,
      files: [
        { path: "a.ts", matches: [{ line: 1, text: "alpha" }] },
        { path: "b.ts", matches: [{ line: 9, text: "beta" }] },
      ],
    })
  })

  test("an empty search is a result, not a parse failure", () => {
    expect(parseGrepOutput("No files found")).toEqual({ total: 0, truncated: false, files: [] })
  })

  test("unrecognised output falls through", () => {
    expect(parseGrepOutput("something else")).toBeUndefined()
  })
})

describe("parseGlobOutput", () => {
  test("lists files", () => {
    expect(parseGlobOutput("a.tsx\nb.tsx")).toEqual({ files: ["a.tsx", "b.tsx"], truncated: false })
  })

  test("an empty glob is a result", () => {
    expect(parseGlobOutput("No files found")).toEqual({ files: [], truncated: false })
  })
})

describe("relativizeProjectPath", () => {
  test("strips the project root and leaves anything else alone", () => {
    expect(relativizeProjectPath("/repo/src/a.ts", "/repo")).toBe("/src/a.ts")
    expect(relativizeProjectPath("/other/a.ts", "/repo")).toBe("/other/a.ts")
    expect(relativizeProjectPath("/repo/a.ts", undefined)).toBe("/repo/a.ts")
  })
})
