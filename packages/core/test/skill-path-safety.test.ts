import path from "path"
import { describe, expect, test } from "bun:test"
import { SkillPathSafety } from "@opencode-ai/core/skill/path-safety"

describe("SkillPathSafety.isSafeSegment", () => {
  test("accepts ordinary skill names", () => {
    for (const name of ["deploy", "agents-sdk", "my.skill", "skill_2", "ünïcode"]) {
      expect(SkillPathSafety.isSafeSegment(name)).toBe(true)
    }
  })

  test("rejects traversal, separators, and empty names", () => {
    for (const name of [
      "",
      ".",
      "..",
      "../outside",
      "..\\outside",
      "nested/name",
      "nested\\name",
      "a/b/../..",
      "with\0null",
      // Drive-relative: no separator, not literally "..", but resolves to a
      // drive root under path.win32.
      "C:..",
      "C:evil",
    ]) {
      expect(SkillPathSafety.isSafeSegment(name)).toBe(false)
    }
  })
})

describe("SkillPathSafety.isSafeRelativePath", () => {
  test("accepts package-relative files", () => {
    for (const file of ["SKILL.md", "references/guide.md", "a/b/c/d.md", "file%20name.md"]) {
      expect(SkillPathSafety.isSafeRelativePath(file)).toBe(true)
    }
  })

  test("rejects traversal in raw and percent-encoded form", () => {
    for (const file of [
      "",
      ".",
      "..",
      "../outside.md",
      "..\\outside.md",
      "a/../../outside.md",
      "%2e%2e/outside.md",
      "%2e%2e%2foutside.md",
      "a/%2e%2e/%2e%2e/outside.md",
    ]) {
      expect(SkillPathSafety.isSafeRelativePath(file)).toBe(false)
    }
  })

  test("rejects absolute paths in both posix and windows form", () => {
    for (const file of [
      "/etc/passwd",
      "/tmp/outside.md",
      "\\windows\\system32",
      "C:/Windows/evil.md",
      "C:\\Windows\\evil.md",
    ]) {
      expect(SkillPathSafety.isSafeRelativePath(file)).toBe(false)
    }
  })

  test("rejects values that are themselves URLs, including protocol-relative", () => {
    // "//evil.example/x" is protocol-relative: resolving it against the source
    // would silently retarget the fetch to another origin.
    for (const file of [
      "https://evil.example/outside.md",
      "http://evil.example/outside.md",
      "//evil.example/outside.md",
      "file:///etc/passwd",
      "data:text/plain,hi",
    ]) {
      expect(SkillPathSafety.isSafeRelativePath(file)).toBe(false)
    }
  })

  test("rejects values carrying query or fragment separators", () => {
    expect(SkillPathSafety.isSafeRelativePath("a.md?x=1")).toBe(false)
    expect(SkillPathSafety.isSafeRelativePath("a.md#frag")).toBe(false)
  })

  test("rejects NUL, windows separators, and malformed percent-encoding", () => {
    expect(SkillPathSafety.isSafeRelativePath("a\0b.md")).toBe(false)
    expect(SkillPathSafety.isSafeRelativePath("a\\b.md")).toBe(false)
    expect(SkillPathSafety.isSafeRelativePath("%")).toBe(false)
    expect(SkillPathSafety.isSafeRelativePath("%zz")).toBe(false)
  })

  test("rejects an empty segment produced by a doubled separator", () => {
    expect(SkillPathSafety.isSafeRelativePath("a//b.md")).toBe(false)
  })
})

describe("SkillPathSafety.canonicalSourceUrl", () => {
  test("adds a trailing slash and keeps the origin", () => {
    expect(SkillPathSafety.canonicalSourceUrl("https://host.test/skills")).toBe("https://host.test/skills/")
    expect(SkillPathSafety.canonicalSourceUrl("https://host.test/skills/")).toBe("https://host.test/skills/")
  })

  test("rejects unparseable and non-http(s) sources", () => {
    for (const url of ["", "not a url", "/relative/skills/", "file:///etc/", "ftp://host.test/skills/"]) {
      expect(SkillPathSafety.canonicalSourceUrl(url)).toBeUndefined()
    }
  })

  test("normalizes equivalent spellings to the same source", () => {
    expect(SkillPathSafety.canonicalSourceUrl("https://host.test/skills")).toBe(
      SkillPathSafety.canonicalSourceUrl("https://host.test/skills/"),
    )
  })

  test("appends the trailing slash to the pathname, not into query or fragment", () => {
    expect(SkillPathSafety.canonicalSourceUrl("https://host.test/skills?token=x")).toBe(
      "https://host.test/skills/?token=x",
    )
    expect(SkillPathSafety.canonicalSourceUrl("https://host.test/skills#frag")).toBe("https://host.test/skills/#frag")
  })

  test("leaves an already-trailing pathname alone", () => {
    expect(SkillPathSafety.canonicalSourceUrl("https://host.test/skills/?token=x")).toBe(
      "https://host.test/skills/?token=x",
    )
  })

  test("gives a query-bearing source its own cache namespace", () => {
    // Distinct URLs must not share a namespace, or one catalog's staged swap
    // could replace another's cached skills.
    const a = SkillPathSafety.canonicalSourceUrl("https://host.test/skills?token=a")!
   const b = SkillPathSafety.canonicalSourceUrl("https://host.test/skills?token=b")!
    expect(SkillPathSafety.sourceNamespace(a)).not.toBe(SkillPathSafety.sourceNamespace(b))
  })
})

describe("SkillPathSafety.sourceNamespace", () => {
  test("is a stable 32-char lowercase hex digest pinned to the canonical URL", () => {
    // Golden value. This pins the mapping so a runtime hash or any change of
    // digest algorithm/length fails here loudly, instead of silently
    // relocating every source's cache namespace.
    expect(SkillPathSafety.sourceNamespace("https://host.test/skills/")).toBe("20bada8e1023f64f8964c72082c4631e")
  })

  test("is deterministic and differs per source", () => {
    const a = SkillPathSafety.sourceNamespace("https://a.example/skills/")
    const b = SkillPathSafety.sourceNamespace("https://b.example/skills/")
    expect(a).toBe(SkillPathSafety.sourceNamespace("https://a.example/skills/"))
    expect(a).not.toBe(b)
  })

  test("produces a single safe path segment", () => {
    const namespace = SkillPathSafety.sourceNamespace("https://a.example/skills/")
    expect(SkillPathSafety.isSafeSegment(namespace)).toBe(true)
    expect(namespace).toMatch(/^[0-9a-f]{32}$/)
    expect(namespace).not.toContain("/")
    expect(namespace).not.toContain("\\")
  })

  test("gives canonical-equivalent spellings the same namespace", () => {
    expect(SkillPathSafety.sourceNamespace(SkillPathSafety.canonicalSourceUrl("https://host.test/skills")!)).toBe(
      SkillPathSafety.sourceNamespace(SkillPathSafety.canonicalSourceUrl("https://host.test/skills/")!),
    )
  })

  test("gives materially different sources, ports, and query values different namespaces", () => {
    const namespaces = [
      "https://host.test/skills/",
      "https://host.test/skills/?token=a",
      "https://host.test/skills/?token=b",
      "https://host.test/other/",
      "https://other.test/skills/",
      "https://host.test:8443/skills/",
    ].map((url) => SkillPathSafety.sourceNamespace(SkillPathSafety.canonicalSourceUrl(url)!))
    expect(new Set(namespaces).size).toBe(namespaces.length)
  })
})

describe("SkillPathSafety.resolveContained", () => {
  test("resolves a contained child", () => {
    expect(SkillPathSafety.resolveContained("/cache/skills", "deploy")).toBe(path.resolve("/cache/skills", "deploy"))
  })

  test("returns undefined for the parent itself", () => {
    // Meaningful for an already-canonical parent: `path.resolve` collapses "."
    // onto it, and the parent-equals-child guard then rejects it.
    const parent = path.resolve("/cache/skills")
    expect(SkillPathSafety.resolveContained(parent, ".")).toBeUndefined()
    expect(SkillPathSafety.resolveContained(parent, "./")).toBeUndefined()
  })

  test("returns undefined when the child escapes the parent", () => {
    expect(SkillPathSafety.resolveContained("/cache/skills", "../outside")).toBeUndefined()
    expect(SkillPathSafety.resolveContained("/cache/skills/deploy", "../../outside")).toBeUndefined()
  })

  test("does not treat a shared string prefix as containment", () => {
    // Sibling-prefix trap: "/cache/skills-evil" is not inside "/cache/skills".
    expect(SkillPathSafety.resolveContained("/cache/skills", "../skills-evil/outside")).toBeUndefined()
  })
})

describe("SkillPathSafety.resolveSkillRoot", () => {
  const sourceRoot = path.resolve("/cache/skills/namespace")

  test("resolves a safe name under the source root", () => {
    expect(SkillPathSafety.resolveSkillRoot(sourceRoot, "deploy")).toBe(path.join(sourceRoot, "deploy"))
  })

  test("refuses names that escape the source namespace", () => {
    for (const name of ["../outside", "..", "../../etc", "a/b", "a\\b", "C:..", ""]) {
      expect(SkillPathSafety.resolveSkillRoot(sourceRoot, name)).toBeUndefined()
    }
  })
})

describe("SkillPathSafety.resolveSkillFile", () => {
  const root = path.resolve("/cache/skills/namespace/deploy")

  test("resolves a nested package-relative file under the skill root", () => {
    expect(SkillPathSafety.resolveSkillFile(root, "references/guide.md")).toBe(
      path.join(root, "references", "guide.md"),
    )
  })

  test("refuses files that escape the skill root", () => {
    for (const file of [
      "../outside.md",
      "../../outside.md",
      "a/../../outside.md",
      "/etc/passwd",
      "C:/Windows/evil.md",
      "C:..",
      "",
      ".",
    ]) {
      expect(SkillPathSafety.resolveSkillFile(root, file)).toBeUndefined()
    }
  })
})

describe("SkillPathSafety.resolveResourceUrl", () => {
  const source = new URL("https://host.test/skills/")
  const skillBase = "https://host.test/skills/deploy/"

  test("resolves a safe file against the skill base", () => {
    expect(SkillPathSafety.resolveResourceUrl(source, skillBase, "references/guide.md")?.href).toBe(
      "https://host.test/skills/deploy/references/guide.md",
    )
  })

  test("refuses an absolute URL on another origin", () => {
    expect(SkillPathSafety.resolveResourceUrl(source, skillBase, "https://evil.example/x.md")).toBeUndefined()
  })

  test("refuses a protocol-relative URL that leaves the origin", () => {
    expect(SkillPathSafety.resolveResourceUrl(source, skillBase, "//evil.example/x.md")).toBeUndefined()
  })

  test("refuses a traversal that walks above the source base", () => {
    // Resolving "../../../other/x.md" against the skill base stays on the same
    // origin, so the origin check alone is not enough — the path predicate has
    // to reject it too.
    expect(SkillPathSafety.resolveResourceUrl(source, skillBase, "../../../other/x.md")).toBeUndefined()
  })

  test("refuses a same-prefix lookalike origin", () => {
    // "https://host.test.evil.example/" shares a string prefix with the source
    // but is a different origin.
    expect(SkillPathSafety.resolveResourceUrl(source, skillBase, "https://host.test.evil.example/x.md")).toBeUndefined()
  })

  test("refuses every URL-shaped entry, even on the source origin", () => {
    // A catalog entry is a package-relative file, never a URL. Accepting an
    // absolute URL even on the source origin would let a catalog name a fetch
    // target that is not under its own skill directory.
    expect(SkillPathSafety.resolveResourceUrl(source, skillBase, "https://host.test/skills/deploy/x.md")).toBeUndefined()
  })
})
