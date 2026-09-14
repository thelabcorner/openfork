import { describe, expect, test } from "bun:test"
import { project, stream } from "./stream"

describe("mobile markdown streaming projection", () => {
  test("keeps frozen blocks stable while ordinary prose grows", () => {
    const first = project(undefined, "# Plan\n\nFinished.\n\nLive", true)
    const heading = first.blocks[0]
    const finished = first.blocks[1]
    const next = project(first, `${first.text} tail keeps growing`, true, first.text.length)
    expect(next.blocks[0]).toBe(heading)
    expect(next.blocks[1]).toBe(finished)
    expect(next.blocks.at(-1)?.raw).toBe("Live tail keeps growing")
  })

  test("treats remend-only trailing whitespace normalization as append-safe", () => {
    const first = project(undefined, "ordinary prose ", true)
    expect(first.blocks[0]?.appendSafe).toBe(true)
    const next = project(first, "ordinary prose continues", true, first.text.length, "continues")
    expect(next.blocks[0]?.raw).toBe("ordinary prose continues")
    expect(next.blocks[0]?.src).toBe("ordinary prose continues")
  })

  test("reprojects only the mutable tail on structural suffixes", () => {
    const first = project(undefined, "# Plan\n\nFinished.\n\nLive tail", true)
    const heading = first.blocks[0]
    const finished = first.blocks[1]
    const inline = project(first, `${first.text} with \`code\``, true, first.text.length)
    expect(inline.blocks[0]).toBe(heading)
    expect(inline.blocks[1]).toBe(finished)
    const list = project(inline, `${inline.text}\n\n- item`, true, inline.text.length)
    expect(list.blocks[0]).toBe(heading)
    expect(list.blocks[1]).toBe(finished)
    expect(list.blocks.at(-1)?.raw).toBe("- item")
  })

  test("falls back exactly for non-prefix replacements", () => {
    const first = project(undefined, "Old text", true)
    const replacement = project(first, "Entirely different text that is longer", true)
    expect(replacement.blocks).toEqual(stream("Entirely different text that is longer", true))
  })

  test("stabilizes a pending nested dash list marker", () => {
    const pending = project(undefined, "- parent\n  -", true)
    expect(pending.blocks.at(-1)?.src).toBe("- parent\n  - \u200b")
    const content = project(pending, `${pending.text} child`, true, pending.text.length)
    expect(content.blocks.at(-1)?.src).toBe("- parent\n  - child")
  })

  test("keeps reference definitions on the whole-message correctness path", () => {
    const first = project(undefined, "[docs][id]\n\nLive", true)
    const text = `${first.text}\n\n[id]: /guide`
    expect(project(first, text, true, first.text.length).blocks).toEqual([{ raw: text, src: text, mode: "live" }])
  })
})
