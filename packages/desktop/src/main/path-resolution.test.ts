import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { expandHomePath, firstExistingPath, PATH_RESOLVE_CANDIDATE_LIMIT } from "./path-resolution"

describe("desktop path resolution", () => {
  test("expands home-relative paths without touching ordinary paths", () => {
    const home = join("root", "home")
    expect(expandHomePath("~", home)).toBe(home)
    expect(expandHomePath("~/project/file.ts", home)).toBe(join(home, "project", "file.ts"))
    expect(expandHomePath("~\\project\\file.ts", home)).toBe(join(home, "project", "file.ts"))
    expect(expandHomePath("src/file.ts", home)).toBe("src/file.ts")
  })

  test("probes in rank order and stops after the winning speculative batch", async () => {
    const seen: string[] = []
    const found = await firstExistingPath(
      ["missing", "real", "never"],
      async (path) => {
        seen.push(path)
        return path === "real"
      },
      (path) => path,
    )
    expect(found).toBe("real")
    expect(seen).toEqual(["missing", "real", "never"])
  })

  test("keeps rank zero as a single-probe fast path", async () => {
    const seen: string[] = []
    const found = await firstExistingPath(
      ["real", ...Array.from({ length: 40 }, (_, index) => `later-${index}`)],
      async (path) => {
        seen.push(path)
        return path === "real"
      },
      (path) => path,
    )
    expect(found).toBe("real")
    expect(seen).toEqual(["real"])
  })

  test("uses an 8-wide first speculative batch then 24-wide batches", async () => {
    const seen: string[] = []
    const paths = Array.from({ length: 64 }, (_, index) => `p${index}`)
    const found = await firstExistingPath(
      paths,
      async (path) => {
        seen.push(path)
        return path === "p25"
      },
      (path) => path,
    )
    expect(found).toBe("p25")
    expect(seen).toEqual(paths.slice(0, 33))
  })

  test("returns the highest-ranked hit even when a later hit completes first", async () => {
    const paths = ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]
    const found = await firstExistingPath(
      paths,
      async (path) => {
        if (path === "p0") return false
        if (path === "p2") {
          await new Promise((resolve) => setTimeout(resolve, 5))
          return true
        }
        return path === "p5"
      },
      (path) => path,
    )
    expect(found).toBe("p2")
  })

  test("expands candidates before probing and returns the expanded path", async () => {
    const seen: string[] = []
    const found = await firstExistingPath(
      ["~/real"],
      async (path) => {
        seen.push(path)
        return true
      },
      (path) => path.replace("~", "HOME"),
    )
    expect(found).toBe("HOME/real")
    expect(seen).toEqual(["HOME/real"])
  })

  test("does not let a failed probe hide a later valid candidate", async () => {
    const found = await firstExistingPath(
      ["throws", "missing", "real"],
      async (path) => {
        if (path === "throws") throw new Error("transient stat failure")
        return path === "real"
      },
      (path) => path,
    )
    expect(found).toBe("real")
  })

  test("surfaces infrastructure failure when every probe fails", async () => {
    const error = new Error("filesystem unavailable")
    await expect(
      firstExistingPath(
        ["a", "b", "c"],
        async () => Promise.reject(error),
        (path) => path,
      ),
    ).rejects.toBe(error)
  })

  test("returns missing when at least one probe completed successfully", async () => {
    const found = await firstExistingPath(
      ["throws", "missing"],
      async (path) => {
        if (path === "throws") throw new Error("transient stat failure")
        return false
      },
      (path) => path,
    )
    expect(found).toBeNull()
  })

  test("bounds hostile candidate lists before filesystem work", async () => {
    let probes = 0
    const paths = Array.from({ length: PATH_RESOLVE_CANDIDATE_LIMIT + 50 }, (_, index) => String(index))
    const found = await firstExistingPath(
      paths,
      async () => {
        probes++
        return false
      },
      (path) => path,
    )
    expect(found).toBeNull()
    expect(probes).toBe(PATH_RESOLVE_CANDIDATE_LIMIT)
  })
})
