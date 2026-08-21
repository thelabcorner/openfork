import { describe, expect, test } from "bun:test"
import { ExternalPath } from "../src/external-path"

describe("ExternalPath.isExternalPathToken", () => {
  const external: Array<[string, string]> = [
    ["windows drive root", "C:"],
    ["windows drive backslash root", "C:\\"],
    ["windows drive forward-slash path", "C:/Users/slooshied/.docker"],
    ["windows drive backslash path", "C:\\Users\\slooshied\\.docker"],
    ["lowercase drive", "c:/temp"],
    ["unc backslash", "\\\\server\\share\\folder"],
    ["unc forward", "//server/share/folder"],
    ["posix absolute", "/home/dev/project"],
    ["posix root", "/"],
    ["home alone", "~"],
    ["home posix child", "~/projects"],
    ["home windows child", "~\\.docker"],
  ]

  for (const [label, token] of external) {
    test(`accepts ${label}: ${token}`, () => {
      expect(ExternalPath.isExternalPathToken(token)).toBe(true)
    })
  }

  const relative: string[] = [
    "",
    "src/index.ts",
    "./src",
    "../parent",
    "..\\..\\escape",
    "packages/core/src",
    "file.txt",
    "C:autoexec.bat",
    "~user/expand",
    "src/C:/not-a-drive",
  ]

  for (const token of relative) {
    test(`rejects project-relative token: ${JSON.stringify(token)}`, () => {
      expect(ExternalPath.isExternalPathToken(token)).toBe(false)
    })
  }
})

describe("ExternalPath.normalizeExternalPathToken", () => {
  test("normalizes separators and strips trailing slash on win32", () => {
    expect(ExternalPath.normalizeExternalPathToken("C:/Users/dev/.docker/", { platform: "win32" })).toBe(
      "C:\\Users\\dev\\.docker",
    )
  })

  test("uppercases drive letter and collapses duplicate separators on win32", () => {
    expect(ExternalPath.normalizeExternalPathToken("c:\\\\Users\\\\dev\\\\.docker", { platform: "win32" })).toBe(
      "C:\\Users\\dev\\.docker",
    )
  })

  test("keeps bare drive rooted on win32", () => {
    expect(ExternalPath.normalizeExternalPathToken("C:", { platform: "win32" })).toBe("C:\\")
    expect(ExternalPath.normalizeExternalPathToken("d:/", { platform: "win32" })).toBe("D:\\")
  })

  test("preserves unc lead and normalizes to platform separator", () => {
    expect(ExternalPath.normalizeExternalPathToken("//server/share/folder/", { platform: "win32" })).toBe(
      "\\\\server\\share\\folder",
    )
    expect(ExternalPath.normalizeExternalPathToken("\\\\server\\share", { platform: "posix" })).toBe(
      "//server/share",
    )
  })

  test("expands home on both platforms", () => {
    expect(ExternalPath.normalizeExternalPathToken("~", { home: "/Users/dev", platform: "posix" })).toBe("/Users/dev")
    expect(ExternalPath.normalizeExternalPathToken("~/projects/x", { home: "/Users/dev", platform: "posix" })).toBe(
      "/Users/dev/projects/x",
    )
    expect(ExternalPath.normalizeExternalPathToken("~\\.docker", { home: "C:\\Users\\dev", platform: "win32" })).toBe(
      "C:\\Users\\dev\\.docker",
    )
  })

  test("leaves ~ unexpanded without a home", () => {
    expect(ExternalPath.normalizeExternalPathToken("~/x", { platform: "posix" })).toBe("~/x")
  })

  test("posix absolute stays canonical", () => {
    expect(ExternalPath.normalizeExternalPathToken("/home//dev/x/", { platform: "posix" })).toBe("/home/dev/x")
    expect(ExternalPath.normalizeExternalPathToken("/", { platform: "posix" })).toBe("/")
  })

  test("passes through non-external tokens unchanged", () => {
    expect(ExternalPath.normalizeExternalPathToken("src/index.ts")).toBe("src/index.ts")
    expect(ExternalPath.normalizeExternalPathToken("")).toBe("")
  })
})
