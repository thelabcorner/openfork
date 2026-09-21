import { describe, expect, test } from "bun:test"
import { normalizeProjectRootsForHost } from "./project-roots"

describe("normalizeProjectRootsForHost", () => {
  test("keeps Windows drive paths native and rejects POSIX/UNC/drive-relative spellings", () => {
    const result = normalizeProjectRootsForHost(
      ["E:\\AlphaGym", "e:/AlphaGym", "/mnt/e/AlphaGym", "\\\\server\\share\\repo", "E:AlphaGym"],
      "win32",
    )

    expect(result.roots).toEqual(["E:\\AlphaGym"])
    expect(result.rejected).toBe(3)
  })

  test("keeps POSIX paths native and rejects Windows drive spellings", () => {
    const result = normalizeProjectRootsForHost(["/srv/AlphaGym", "/srv/AlphaGym/", "E:\\AlphaGym"], "linux")

    expect(result.roots).toEqual(["/srv/AlphaGym"])
    expect(result.rejected).toBe(1)
  })
})
