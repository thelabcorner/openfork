import { describe, expect, test } from "bun:test"
import {
  basename,
  firstExistingPath,
  isAbsolutePath,
  joinPath,
  normalizeSeparators,
  pathCandidates,
  pickPathMatch,
  rankPathMatches,
} from "./markdown-path-resolve"

describe("isAbsolutePath", () => {
  test("recognizes posix, windows and unc roots", () => {
    expect(isAbsolutePath("/usr/local/bin")).toBe(true)
    expect(isAbsolutePath("C:\\Users\\me\\notes.md")).toBe(true)
    expect(isAbsolutePath("C:/Users/me/notes.md")).toBe(true)
    expect(isAbsolutePath("\\\\server\\share\\file.txt")).toBe(true)
  })

  test("treats written mentions as relative", () => {
    expect(isAbsolutePath("patch_dist.mjs")).toBe(false)
    expect(isAbsolutePath("candidate/snapdom-candidate.mjs")).toBe(false)
    expect(isAbsolutePath("./diff.mjs")).toBe(false)
    expect(isAbsolutePath("C:")).toBe(false)
    expect(isAbsolutePath("")).toBe(false)
  })
})

describe("normalizeSeparators", () => {
  test("rewrites every separator to one convention", () => {
    expect(normalizeSeparators("C:\\repo\\lane4/v3prod/sink.mjs", "\\")).toBe("C:\\repo\\lane4\\v3prod\\sink.mjs")
    expect(normalizeSeparators("/repo\\lane4/v3prod", "/")).toBe("/repo/lane4/v3prod")
  })

  test("keeps a unc prefix intact", () => {
    expect(normalizeSeparators("\\\\server\\share\\file.txt", "\\")).toBe("\\\\server\\share\\file.txt")
  })
})

describe("joinPath", () => {
  test("joins with the separator the directory already uses", () => {
    expect(joinPath("C:\\repo", "src\\main.rs")).toBe("C:\\repo\\src\\main.rs")
    expect(joinPath("/home/me/repo", "src/main.rs")).toBe("/home/me/repo/src/main.rs")
  })

  // The index answers with `/` while the project directory uses `\`.
  test("normalizes an index path into the directory's convention", () => {
    expect(joinPath("C:\\Users\\me\\presGEN_v2", "lane4-scratch/v3prod/sink_ab.mjs")).toBe(
      "C:\\Users\\me\\presGEN_v2\\lane4-scratch\\v3prod\\sink_ab.mjs",
    )
    expect(joinPath("/home/me/repo", "lane4-scratch\\v3prod\\sink_ab.mjs")).toBe(
      "/home/me/repo/lane4-scratch/v3prod/sink_ab.mjs",
    )
  })

  test("does not double separators", () => {
    expect(joinPath("/repo/", "src/main.rs")).toBe("/repo/src/main.rs")
    // A lone leading backslash is relative on Windows, not a root.
    expect(joinPath("C:\\repo", "\\src\\main.rs")).toBe("C:\\repo\\src\\main.rs")
  })

  test("leaves an absolute path alone apart from normalizing it", () => {
    expect(joinPath("/repo", "/etc/hosts")).toBe("/etc/hosts")
    expect(joinPath("/repo", "C:\\x\\y.md")).toBe("C:\\x\\y.md")
  })
})

describe("basename", () => {
  test("takes the last segment of either separator", () => {
    expect(basename("a/b/c.ts")).toBe("c.ts")
    expect(basename("a\\b\\c.ts")).toBe("c.ts")
    expect(basename("c.ts")).toBe("c.ts")
    expect(basename("a/b/c.ts/")).toBe("c.ts")
  })
})

describe("rankPathMatches", () => {
  const index = [
    "packages/app/src/diff.mjs",
    "packages/core/fixtures/deep/nested/diff.mjs",
    "lane4/candidate/snapdom-candidate.mjs",
    "tools/patch_dist.mjs",
    "README.md",
  ]

  test("prefers an exact relative match", () => {
    expect(pickPathMatch("README.md", index)).toBe("README.md")
  })

  test("matches a written subpath against a deeper location", () => {
    expect(pickPathMatch("candidate/snapdom-candidate.mjs", index)).toBe("lane4/candidate/snapdom-candidate.mjs")
  })

  test("resolves a bare filename mentioned in prose", () => {
    expect(pickPathMatch("patch_dist.mjs", index)).toBe("tools/patch_dist.mjs")
  })

  test("orders same-name hits shallowest first so every one stays reachable", () => {
    expect(rankPathMatches("diff.mjs", index)).toEqual([
      "packages/app/src/diff.mjs",
      "packages/core/fixtures/deep/nested/diff.mjs",
    ])
  })

  test("matches across separator styles", () => {
    expect(pickPathMatch("candidate\\snapdom-candidate.mjs", index)).toBe("lane4/candidate/snapdom-candidate.mjs")
    expect(pickPathMatch("diff.mjs", ["packages\\app\\src\\diff.mjs"])).toBe("packages\\app\\src\\diff.mjs")
  })

  test("is case insensitive", () => {
    expect(pickPathMatch("readme.md", index)).toBe("README.md")
  })

  test("returns nothing when the index has no plausible entry", () => {
    expect(pickPathMatch("absent.mjs", index)).toBeUndefined()
    expect(pickPathMatch("diff.mjs", [])).toBeUndefined()
    expect(pickPathMatch("", index)).toBeUndefined()
  })

  test("does not match a filename that merely shares a suffix", () => {
    expect(pickPathMatch("iff.mjs", index)).toBeUndefined()
  })
})

describe("pathCandidates", () => {
  const directory = "C:\\Users\\me\\presGEN_v2"

  test("an absolute mention is taken at its word", () => {
    expect(pathCandidates({ written: "C:\\a\\b.md", directory, matches: ["x/b.md"] })).toEqual(["C:\\a\\b.md"])
  })

  test("ranks index hits first, normalized, then the literal mention", () => {
    expect(
      pathCandidates({
        written: "sink_ab.mjs",
        directory,
        matches: ["lane4-scratch/v3prod/sink_ab.mjs", "a/b/c/sink_ab.mjs"],
      }),
    ).toEqual([
      "C:\\Users\\me\\presGEN_v2\\lane4-scratch\\v3prod\\sink_ab.mjs",
      "C:\\Users\\me\\presGEN_v2\\a\\b\\c\\sink_ab.mjs",
      "C:\\Users\\me\\presGEN_v2\\sink_ab.mjs",
    ])
  })

  test("keeps an already-absolute index hit as its own candidate", () => {
    const out = pathCandidates({ written: "sink_ab.mjs", directory, matches: ["D:\\other\\sink_ab.mjs"] })
    expect(out).toContain("D:\\other\\sink_ab.mjs")
  })

  test("prefers the server-authoritative base over a client reconstruction", () => {
    expect(
      pathCandidates({
        written: "sink_ab.mjs",
        directory: "C:\\alias\\presGEN_v2",
        canonicalDirectory: "D:\\canonical\\presGEN_v2",
        matches: ["lane4-scratch/v3prod/sink_ab.mjs"],
      }),
    ).toEqual([
      "D:\\canonical\\presGEN_v2\\lane4-scratch\\v3prod\\sink_ab.mjs",
      "C:\\alias\\presGEN_v2\\sink_ab.mjs",
    ])
  })

  test("tries an exact canonical subpath before fuzzy duplicate-name hits", () => {
    const duplicates = Array.from({ length: 50 }, (_, index) => `fixtures/${index}/sink_ab.mjs`)
    const out = pathCandidates({
      written: "lane4-scratch/v3prod/sink_ab.mjs",
      directory: "C:\\alias\\presGEN_v2",
      canonicalDirectory: "D:\\canonical\\presGEN_v2",
      matches: duplicates,
    })
    expect(out[0]).toBe("D:\\canonical\\presGEN_v2\\lane4-scratch\\v3prod\\sink_ab.mjs")
  })

  test("falls back to the literal mention when the index is empty", () => {
    expect(pathCandidates({ written: "docs/readme.md", directory, matches: [] })).toEqual([
      "C:\\Users\\me\\presGEN_v2\\docs\\readme.md",
    ])
  })

  test("does not repeat a candidate", () => {
    const out = pathCandidates({ written: "README.md", directory, matches: ["README.md"] })
    expect(out).toEqual(["C:\\Users\\me\\presGEN_v2\\README.md"])
  })

  test("deduplicates windows candidates that differ only by case or separator spelling", () => {
    const out = pathCandidates({
      written: "README.md",
      directory: "C:\\Repo",
      canonicalDirectory: "c:/repo",
      matches: ["README.md"],
    })
    expect(out).toEqual(["c:/repo/README.md"])
  })

  test("keeps case-distinct posix paths distinct", () => {
    const out = pathCandidates({
      written: "README.md",
      directory: "/repo",
      matches: ["Docs/README.md", "docs/README.md"],
    })
    expect(out).toEqual(["/repo/Docs/README.md", "/repo/docs/README.md", "/repo/README.md"])
  })

  test("normalizes a canonical UNC workspace without losing its share prefix", () => {
    const out = pathCandidates({
      written: "src/main.ts",
      directory: "C:\\alias",
      canonicalDirectory: "\\\\server\\share\\repo",
      matches: [],
    })
    expect(out[0]).toBe("\\\\server\\share\\repo\\src\\main.ts")
  })
})

describe("firstExistingPath", () => {
  test("uses the first ranked candidate when the desktop probe is unavailable", async () => {
    await expect(firstExistingPath(["a", "b"])).resolves.toBe("a")
  })

  test("falls through missing and failed probes and stops at the first existing path", async () => {
    const seen: string[] = []
    const found = await firstExistingPath(["stale", "throws", "real", "never"], async (path) => {
      seen.push(path)
      if (path === "throws") throw new Error("probe failed")
      return path === "real"
    })
    expect(found).toBe("real")
    expect(seen).toEqual(["stale", "throws", "real"])
  })

  test("returns undefined when every probed candidate is missing", async () => {
    await expect(firstExistingPath(["a", "b"], async () => false)).resolves.toBeUndefined()
  })

  test("surfaces an infrastructure failure when every probe throws", async () => {
    const error = new Error("path-exists IPC unavailable")
    await expect(firstExistingPath(["a", "b"], async () => Promise.reject(error))).rejects.toBe(error)
  })

  test("still reports missing when at least one probe completed successfully", async () => {
    let calls = 0
    const found = await firstExistingPath(["throws", "missing"], async (path) => {
      calls++
      if (path === "throws") throw new Error("transient IPC error")
      return false
    })
    expect(found).toBeUndefined()
    expect(calls).toBe(2)
  })
})
