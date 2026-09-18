import { describe, expect, test } from "bun:test"
import {
  basename,
  firstExistingPath,
  isAbbreviatedPath,
  isAbsolutePath,
  joinPath,
  normalizeSeparators,
  pathCandidates,
  pickPathMatch,
  rankPathMatches,
  resolveMarkdownCandidates,
  setMarkdownPathResolver,
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

describe("isAbbreviatedPath", () => {
  test("recognizes only whole omission segments", () => {
    expect(isAbbreviatedPath("C:\\repo\\...\\report.html")).toBe(true)
    expect(isAbbreviatedPath("/repo/…/report.html")).toBe(true)
    expect(isAbbreviatedPath("src/.../report.html")).toBe(true)
    expect(isAbbreviatedPath("src/foo...bar/report.html")).toBe(false)
    expect(isAbbreviatedPath("src/...ish/report.html")).toBe(false)
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

  test("stays equivalent to the original rank semantics across a generated corpus", () => {
    const referenceNormalize = (value: string) =>
      value
        .replace(/[\\/]+/g, "/")
        .replace(/^\/+|\/+$/g, "")
        .toLowerCase()
    const referenceDepth = (value: string) => (value ? value.split("/").length : 0)
    const reference = (written: string, candidates: readonly string[]) => {
      const target = referenceNormalize(written)
      if (!target) return []
      const targetName = basename(target)
      const exact: Array<{ value: string; depth: number; index: number }> = []
      const suffixed: Array<{ value: string; depth: number; index: number }> = []
      const named: Array<{ value: string; depth: number; index: number }> = []
      candidates.forEach((candidate, candidateIndex) => {
        const value = referenceNormalize(candidate)
        if (!value) return
        const entry = { value: candidate, depth: referenceDepth(value), index: candidateIndex }
        if (value === target) exact.push(entry)
        else if (value.endsWith(`/${target}`)) suffixed.push(entry)
        else if (basename(value) === targetName) named.push(entry)
      })
      const byDepth = (a: { depth: number; index: number }, b: { depth: number; index: number }) =>
        a.depth - b.depth || a.index - b.index
      return [...exact.sort(byDepth), ...suffixed.sort(byDepth), ...named.sort(byDepth)].map((entry) => entry.value)
    }

    const separators = ["/", "\\"]
    const candidates = Array.from({ length: 180 }, (_, index) => {
      const separator = separators[index % separators.length]!
      const depth = (index % 6) + 1
      const prefix = Array.from({ length: depth }, (_, part) => `d${(index + part) % 13}`).join(separator)
      const name = index % 5 === 0 ? "README.md" : index % 3 === 0 ? "shared.ts" : `file-${index % 29}.mjs`
      return `${prefix}${separator}${index % 7 === 0 ? name.toUpperCase() : name}`
    })
    const written = [
      "README.md",
      "shared.ts",
      "d1/shared.ts",
      "D2\\SHARED.TS",
      "file-7.mjs",
      "d5/file-12.mjs",
      "absent.ts",
      ...candidates.filter((_, index) => index % 17 === 0),
    ]

    for (const value of written) expect(rankPathMatches(value, candidates)).toEqual(reference(value, candidates))
  })
})

describe("pathCandidates", () => {
  const directory = "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2"

  test("an absolute mention is taken at its word", () => {
    expect(pathCandidates({ written: "C:\\a\\b.md", directory, matches: ["x/b.md"] })).toEqual(["C:\\a\\b.md"])
  })

  test("expands an omission inside an absolute workspace path through indexed candidates", () => {
    const written =
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\third_party_modules\\forgeprint\\...\\forgeprint-output\\iter00-baseline"
    expect(
      pathCandidates({
        written,
        directory,
        canonicalDirectory: directory,
        matches: [
          "other/iter00-baseline",
          "third_party_modules/forgeprint/cache/run/forgeprint-output/iter00-baseline",
        ],
      }),
    ).toEqual([
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\third_party_modules\\forgeprint\\cache\\run\\forgeprint-output\\iter00-baseline",
    ])
  })

  test("expands an abbreviated absolute workspace prefix into one concrete suffix", () => {
    const bigfoot = "E:\\Other computers\\Windows 11 - 2022\\Graphic Design\\Bigfoot Peanut Butter Co\\bigfootSalesForm"
    expect(
      pathCandidates({
        written: "E:\\...\\bigfootSalesForm\\forgeprint-output\\verify\\report.html",
        directory: bigfoot,
        canonicalDirectory: bigfoot,
        matches: [],
      }),
    ).toEqual([`${bigfoot}\\forgeprint-output\\verify\\report.html`])
  })

  test("supports a unicode omission marker and suffix-style relative matching", () => {
    expect(
      pathCandidates({
        written: "src/…/report.html",
        directory,
        matches: ["packages/demo/src/generated/report.html", "packages/demo/report.html"],
      }),
    ).toEqual(["C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\packages\\demo\\src\\generated\\report.html"])
  })

  test("never reinterprets an abbreviated absolute path as belonging to another workspace", () => {
    expect(
      pathCandidates({
        written: "E:\\...\\other-project\\report.html",
        directory,
        canonicalDirectory: directory,
        matches: ["report.html"],
      }),
    ).toEqual([])
  })

  test("keeps POSIX workspace-prefix ownership case-sensitive", () => {
    expect(
      pathCandidates({
        written: "/Home/me/.../repo/report.html",
        directory: "/home/me/work/repo",
        canonicalDirectory: "/home/me/work/repo",
        matches: ["report.html"],
      }),
    ).toEqual([])
  })

  test("never emits a literal omission segment to the filesystem", () => {
    const out = pathCandidates({
      written: "src/.../report.html",
      directory,
      matches: ["src/build/report.html", "src/cache/report.html"],
    })
    expect(out).toEqual([
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\src\\build\\report.html",
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\src\\cache\\report.html",
    ])
    expect(out.every((candidate) => !isAbbreviatedPath(candidate))).toBe(true)
  })

  test("keeps home-relative mentions out of the project root", () => {
    expect(
      pathCandidates({
        written: "~/.config/opencode/opencode.json",
        directory,
        canonicalDirectory: "D:\\canonical\\presGEN_v2",
        matches: [],
      }),
    ).toEqual(["~/.config/opencode/opencode.json"])
  })

  test("ranks index hits first, normalized, then the literal mention", () => {
    expect(
      pathCandidates({
        written: "sink_ab.mjs",
        directory,
        matches: ["lane4-scratch/v3prod/sink_ab.mjs", "a/b/c/sink_ab.mjs"],
      }),
    ).toEqual([
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\lane4-scratch\\v3prod\\sink_ab.mjs",
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\a\\b\\c\\sink_ab.mjs",
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\sink_ab.mjs",
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
      "C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\docs\\readme.md",
    ])
  })

  test("does not repeat a candidate", () => {
    const out = pathCandidates({ written: "README.md", directory, matches: ["README.md"] })
    expect(out).toEqual(["C:\\Users\\slooshied\\WebstormProjects\\presGEN_v2\\README.md"])
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

  test("uses one bulk resolver when the desktop bridge supports it", async () => {
    let legacyCalls = 0
    let bulkCalls = 0
    const found = await firstExistingPath(
      ["missing", "real", "never"],
      async () => {
        legacyCalls++
        return false
      },
      async (paths) => {
        bulkCalls++
        expect(paths).toEqual(["missing", "real", "never"])
        return "real"
      },
    )
    expect(found).toBe("real")
    expect(bulkCalls).toBe(1)
    expect(legacyCalls).toBe(0)
  })
})

describe("markdown resolver registry", () => {
  test("routes abbreviated absolute paths through the workspace resolver", async () => {
    const seen: string[] = []
    const dispose = setMarkdownPathResolver(async (written) => {
      seen.push(written)
      return ["resolved"]
    })
    try {
      const written = "E:\\...\\bigfootSalesForm\\forgeprint-output\\verify\\report.html"
      await expect(resolveMarkdownCandidates(written)).resolves.toEqual(["resolved"])
      expect(seen).toEqual([written])
    } finally {
      dispose()
    }
  })

  test("keeps concrete absolute paths on the zero-search fast path", async () => {
    let calls = 0
    const dispose = setMarkdownPathResolver(async () => {
      calls++
      return ["wrong"]
    })
    try {
      await expect(resolveMarkdownCandidates("C:\\repo\\report.html")).resolves.toEqual(["C:\\repo\\report.html"])
      expect(calls).toBe(0)
    } finally {
      dispose()
    }
  })

  test("falls back to the previous resolver when an overlapping scope unmounts", async () => {
    const disposeOuter = setMarkdownPathResolver(async (written) => [`outer/${written}`])
    const disposeInner = setMarkdownPathResolver(async (written) => [`inner/${written}`])
    try {
      await expect(resolveMarkdownCandidates("file.ts")).resolves.toEqual(["inner/file.ts"])
      disposeInner()
      await expect(resolveMarkdownCandidates("file.ts")).resolves.toEqual(["outer/file.ts"])
    } finally {
      disposeInner()
      disposeOuter()
    }
  })

  test("preserves resolver infrastructure failures", async () => {
    const error = new Error("mention index transport failed")
    const dispose = setMarkdownPathResolver(async () => Promise.reject(error))
    try {
      await expect(resolveMarkdownCandidates("file.ts")).rejects.toBe(error)
    } finally {
      dispose()
    }
  })
})
