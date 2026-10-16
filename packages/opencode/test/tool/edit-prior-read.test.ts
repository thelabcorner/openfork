import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Option } from "effect"
import { ReadCache, enforce } from "../../src/tool/edit/prior-read"

describe("edit prior-read grounding", () => {
  test("navigation-only observations warn for line-targeted edits", async () => {
    const cache = new ReadCache()
    cache.recordRead("session-a", "/f.txt", 1000, 5, false)
    const afs = {
      stat: () => Effect.succeed({ type: "File", mtime: Option.some(new Date(1000)), size: 5 }),
    } as never

    const outcome = await Effect.runPromise(enforce(Option.some(cache), afs, "session-a", "/f.txt", "line"))
    expect(outcome.refusal).toBeUndefined()
    expect(outcome.warning).toContain("only been written, not read as full text")
  })

  test("dot-segment aliases share the same session record", () => {
    const cache = new ReadCache()
    const file = path.resolve("read-grounding-test.txt")
    const alias = `${path.dirname(file)}${path.sep}unused${path.sep}..${path.sep}${path.basename(file)}`
    cache.recordRead("session-a", file, 1000, 5)
    expect(cache.get("session-a", alias)).toEqual(cache.get("session-a", file))
  })
})
