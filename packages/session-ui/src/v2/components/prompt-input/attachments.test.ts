import { describe, expect, test } from "bun:test"
import { archiveInstructions, detectArchiveKind, largePaste, pasteFilename } from "./attachments"

describe("largePaste", () => {
  test("short single-line text is not large", () => {
    expect(largePaste("hello world")).toBe(false)
  })

  test("text just under the char threshold is not large", () => {
    expect(largePaste("a".repeat(7999))).toBe(false)
  })

  test("text at the char threshold is large", () => {
    expect(largePaste("a".repeat(8000))).toBe(true)
  })

  test("text just under the line threshold is not large", () => {
    expect(largePaste("a\n".repeat(119))).toBe(false)
  })

  test("text at the line threshold is large", () => {
    expect(largePaste("a\n".repeat(120))).toBe(true)
  })

  test("empty text is not large", () => {
    expect(largePaste("")).toBe(false)
  })
})

describe("pasteFilename", () => {
  test("produces a timestamped markdown filename", () => {
    const name = pasteFilename()
    expect(name).toMatch(/^pasted-[\d-]+T[\d-]+Z\.md$/)
  })

  test("produces a unique-ish name across calls", async () => {
    const first = pasteFilename()
    await new Promise((resolve) => setTimeout(resolve, 5))
    const second = pasteFilename()
    expect(first).not.toBe(second)
  })
})

describe("detectArchiveKind", () => {
  test("recognizes zip, 7z, and rar", () => {
    expect(detectArchiveKind("project.zip")).toBe("zip")
    expect(detectArchiveKind("project.7z")).toBe("7z")
    expect(detectArchiveKind("project.rar")).toBe("rar")
  })

  test("recognizes tar containers, plain and compressed", () => {
    expect(detectArchiveKind("project.tar")).toBe("tar")
    expect(detectArchiveKind("project.tar.gz")).toBe("tar.gz")
    expect(detectArchiveKind("project.tgz")).toBe("tgz")
    expect(detectArchiveKind("project.tar.bz2")).toBe("tar.bz2")
    expect(detectArchiveKind("project.tbz2")).toBe("tbz2")
    expect(detectArchiveKind("project.tar.xz")).toBe("tar.xz")
    expect(detectArchiveKind("project.txz")).toBe("txz")
    expect(detectArchiveKind("project.tar.zst")).toBe("tar.zst")
    expect(detectArchiveKind("project.tzst")).toBe("tzst")
  })

  test("recognizes single-file compression streams", () => {
    expect(detectArchiveKind("data.gz")).toBe("gz")
    expect(detectArchiveKind("data.bz2")).toBe("bz2")
    expect(detectArchiveKind("data.xz")).toBe("xz")
    expect(detectArchiveKind("data.zst")).toBe("zst")
    expect(detectArchiveKind("data.br")).toBe("br")
    expect(detectArchiveKind("data.lz4")).toBe("lz4")
    expect(detectArchiveKind("data.lzma")).toBe("lzma")
  })

  test("prefers the compound tar suffix over the bare compression suffix", () => {
    expect(detectArchiveKind("dataset.tar.gz")).toBe("tar.gz")
    expect(detectArchiveKind("dataset.tar.gz")).not.toBe("gz")
  })

  test("is case-insensitive", () => {
    expect(detectArchiveKind("PROJECT.ZIP")).toBe("zip")
    expect(detectArchiveKind("Archive.Tar.Gz")).toBe("tar.gz")
  })

  test("ignores non-archive files", () => {
    expect(detectArchiveKind("readme.md")).toBeUndefined()
    expect(detectArchiveKind("photo.png")).toBeUndefined()
    expect(detectArchiveKind("noextension")).toBeUndefined()
  })
})

describe("archiveInstructions", () => {
  test("includes the path, kind, size, and archive-tool guidance", () => {
    const text = archiveInstructions("/Users/jack/Downloads/dataset.tar.gz", "tar.gz", 128 * 1024 * 1024)
    expect(text).toContain("/Users/jack/Downloads/dataset.tar.gz")
    expect(text).toContain("tar.gz")
    expect(text).toContain("128 MB")
    expect(text).toContain("archive tool")
    expect(text.toLowerCase()).toContain("do not read the raw archive bytes")
  })
})
