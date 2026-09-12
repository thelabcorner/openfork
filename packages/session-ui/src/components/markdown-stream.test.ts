import { describe, expect, test } from "bun:test"
import { canReusePendingBlock } from "./markdown-projection"
import { project, stream } from "./markdown-stream"

describe("markdown stream", () => {
  test("heals incomplete emphasis while streaming", () => {
    expect(stream("hello **world", true)).toEqual([{ raw: "hello **world", src: "hello **world**", mode: "live" }])
    expect(stream("say `code", true)).toEqual([{ raw: "say `code", src: "say `code`", mode: "live" }])
  })

  test("does not collapse a pending bullet marker into the previous item", () => {
    // A pending list marker receives invisible content so it remains an actual
    // list item instead of becoming remend's `-<U+200B>` lazy continuation.
    expect(stream("- first item\n-", true)).toEqual([
      { raw: "- first item\n-", src: "- first item\n- \u200b", mode: "live" },
    ])
    expect(stream("- a\n- b\n-", true)).toEqual([
      { raw: "- a\n- b\n-", src: "- a\n- b\n- \u200b", mode: "live" },
    ])
  })

  test("stabilizes nested list markers across ordered and unordered permutations", () => {
    const parents = [
      { marker: "-", indent: "  " },
      { marker: "*", indent: "  " },
      { marker: "+", indent: "  " },
      { marker: "1.", indent: "   " },
      { marker: "1)", indent: "   " },
    ]
    const children = ["-", "*", "+", "1.", "1)"]

    for (const parent of parents) {
      for (const child of children) {
        const first = `${parent.marker} parent\n${parent.indent}${child}`
        expect(stream(first, true).at(-1)?.src).toBe(child === "-" ? `${first} \u200b` : first)

        const sibling = `${parent.marker} parent\n${parent.indent}${child} child\n${parent.indent}-`
        expect(stream(sibling, true).at(-1)?.src).toBe(`${sibling} \u200b`)

        const childIndent = " ".repeat(child.length + 1)
        const grandchild = `${parent.marker} parent\n${parent.indent}${child} child\n${parent.indent}${childIndent}-`
        expect(stream(grandchild, true).at(-1)?.src).toBe(`${grandchild} \u200b`)
      }
    }
  })

  test("re-heals a stabilized nested marker as soon as content arrives", () => {
    const pending = project(undefined, "- parent\n  -", true)
    expect(pending.blocks.at(-1)?.src).toBe("- parent\n  - \u200b")

    const spaced = project(pending, `${pending.text} `, true)
    expect(spaced.blocks.at(-1)?.raw).toBe("- parent\n  - ")
    expect(spaced.blocks.at(-1)?.src).toBe("- parent\n  - \u200b")

    const content = project(spaced, `${spaced.text}child`, true)
    expect(content.blocks.at(-1)?.src).toBe("- parent\n  - child")
  })

  test("keeps remend's setext guard outside an active list", () => {
    expect(stream("real paragraph\n-", true)).toEqual([
      { raw: "real paragraph\n-", src: "real paragraph\n-​", mode: "live" },
    ])
    expect(stream("real paragraph\n=", true)).toEqual([
      { raw: "real paragraph\n=", src: "real paragraph\n=​", mode: "live" },
    ])
    expect(stream("- a\n\nreal paragraph\n-", true).at(-1)?.src).toBe("real paragraph\n-​")
  })

  test("does not force invalid list indentation into a nested item", () => {
    const text = "- parent\n      -"
    expect(stream(text, true).at(-1)?.src).not.toContain("- \u200b")
  })

  test("keeps incomplete links non-clickable until they finish", () => {
    expect(stream("see [docs](https://example.com/gu", true)).toEqual([
      { raw: "see [docs](https://example.com/gu", src: "see docs", mode: "live" },
    ])
  })

  test("splits an unfinished trailing code fence from stable content", () => {
    expect(stream("before\n\n```ts\nconst x = 1", true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "full" },
      { raw: "```ts\nconst x = 1", src: "const x = 1", mode: "code", language: "ts" },
    ])
  })

  test("fully parses a code fence once it closes", () => {
    const text = "before\n\n```ts\nconst x = 1\n```"
    expect(stream(text, true)).toEqual([
      { raw: "before\n\n", src: "before\n\n", mode: "full" },
      { raw: "```ts\nconst x = 1\n```", src: "const x = 1", mode: "code", language: "ts", complete: true },
    ])
  })

  test("keeps Mermaid fences in cheap code mode until the fence is complete", () => {
    expect(stream("```mermaid\nflowchart LR\nA-->B", true)).toEqual([
      {
        raw: "```mermaid\nflowchart LR\nA-->B",
        src: "flowchart LR\nA-->B",
        mode: "code",
        language: "mermaid",
      },
    ])
    expect(stream("```mermaid\nflowchart LR\nA-->B\n```", true)).toEqual([
      {
        raw: "```mermaid\nflowchart LR\nA-->B\n```",
        src: "flowchart LR\nA-->B",
        mode: "code",
        language: "mermaid",
        complete: true,
      },
    ])
  })

  test("keeps a completed code fence in worker-rendered code mode when prose follows", () => {
    expect(stream("```ts\nconst x = 1\n```\n\nafter", true)).toEqual([
      { raw: "```ts\nconst x = 1\n```\n\n", src: "const x = 1", mode: "code", language: "ts", complete: true },
      { raw: "after", src: "after", mode: "live" },
    ])
  })

  test("freezes completed top-level blocks and only keeps the tail live", () => {
    expect(stream("# Plan\n\nFinished paragraph.\n\n- live item", true)).toEqual([
      { raw: "# Plan\n\n", src: "# Plan\n\n", mode: "full" },
      { raw: "Finished paragraph.\n\n", src: "Finished paragraph.\n\n", mode: "full" },
      { raw: "- live item", src: "- live item", mode: "live" },
    ])
  })

  test("freezes a paragraph before a new list before later inline syntax can trigger a split", () => {
    const approach = project(undefined, "Approach:\n\n", true)
    const bullet = project(approach, "Approach:\n\n-", true)
    expect(bullet.blocks).toEqual([
      { raw: "Approach:\n\n", src: "Approach:\n\n", mode: "full" },
      { raw: "-", src: "-", mode: "live" },
    ])

    const prose = project(bullet, "Approach:\n\n- Read source", true)
    expect(prose.blocks).toHaveLength(2)
    expect(prose.blocks[0]).toEqual(bullet.blocks[0])

    const code = project(prose, "Approach:\n\n- Read source `file.ts`", true)
    expect(code.blocks).toHaveLength(2)
    expect(code.blocks[0]).toEqual(bullet.blocks[0])

    // Once the next top-level block has started, no later character is allowed
    // to be the event that suddenly changes the projection from one block to
    // two. That delayed topology change was the visible timeline jump.
    const full = "Approach:\n\n- Read source `file.ts` and continue"
    let incremental = project(undefined, "Approach:\n\n-", true)
    for (let index = "Approach:\n\n-".length + 1; index <= full.length; index++) {
      incremental = project(incremental, full.slice(0, index), true)
      expect(incremental.blocks).toHaveLength(2)
    }

    const insights = project(undefined, "KEY INSIGHTS:\n\n1", true)
    expect(insights.blocks).toEqual([
      { raw: "KEY INSIGHTS:\n\n", src: "KEY INSIGHTS:\n\n", mode: "full" },
      { raw: "1", src: "1", mode: "live" },
    ])
  })

  test("does not split a blank line that remains inside one list block", () => {
    const text = "- item\n\n  continuation"
    let projection: ReturnType<typeof project> | undefined
    for (let index = 1; index <= text.length; index++) projection = project(projection, text.slice(0, index), true)
    expect(projection?.blocks).toEqual([{ raw: text, src: text, mode: "live" }])
  })

  test("keeps a growing table together until a later block freezes it", () => {
    expect(stream("| a | b |\n|---|---|\n| 1 | 2 |", true)).toEqual([
      { raw: "| a | b |\n|---|---|\n| 1 | 2 |", src: "| a | b |\n|---|---|\n| 1 | 2 |", mode: "live" },
    ])
  })

  test("reprojects non-prefix replacements from current content", () => {
    expect(stream("# Replacement\n\nNew body", true)).toEqual([
      { raw: "# Replacement\n\n", src: "# Replacement\n\n", mode: "full" },
      { raw: "New body", src: "New body", mode: "live" },
    ])
  })

  test("reprojects truncation without retaining removed blocks", () => {
    expect(stream("Only the restored prefix", true)).toEqual([
      { raw: "Only the restored prefix", src: "Only the restored prefix", mode: "live" },
    ])
  })

  test("shifts later blocks when an earlier block is inserted", () => {
    expect(stream("# Inserted\n\nFirst body\n\nSecond body", true)).toEqual([
      { raw: "# Inserted\n\n", src: "# Inserted\n\n", mode: "full" },
      { raw: "First body\n\n", src: "First body\n\n", mode: "full" },
      { raw: "Second body", src: "Second body", mode: "live" },
    ])
  })

  test("keeps reference-style markdown as one block", () => {
    expect(stream("[docs][1]\n\n[1]: https://example.com", true)).toEqual([
      {
        raw: "[docs][1]\n\n[1]: https://example.com",
        src: "[docs][1]\n\n[1]: https://example.com",
        mode: "live",
      },
    ])
  })

  test("keeps compact and indented reference definitions with their uses", () => {
    expect(stream("[docs]\n\n   [docs]:/guide", true)).toEqual([
      {
        raw: "[docs]\n\n   [docs]:/guide",
        src: "[docs]\n\n   [docs]:/guide",
        mode: "live",
      },
    ])
  })

  test("keeps multiline reference definitions with their uses", () => {
    expect(stream("[docs][id]\n\n[id]:\n  /guide", true)).toEqual([
      {
        raw: "[docs][id]\n\n[id]:\n  /guide",
        src: "[docs][id]\n\n[id]:\n  /guide",
        mode: "live",
      },
    ])
  })

  test("uses only the language portion of fence metadata", () => {
    expect(stream("```ts title=example\nconst x = 1", true)).toEqual([
      {
        raw: "```ts title=example\nconst x = 1",
        src: "const x = 1",
        mode: "code",
        language: "ts",
      },
    ])
  })

  test("preserves trailing newlines in open code fences", () => {
    expect(stream("```ts\nconst x = 1\n", true)).toEqual([
      {
        raw: "```ts\nconst x = 1\n",
        src: "const x = 1\n",
        mode: "code",
        language: "ts",
      },
    ])
  })

  test("only reuses pending blocks with compatible identity and content", () => {
    expect(
      canReusePendingBlock({ mode: "full", raw: "First\n\n" }, { mode: "full", raw: "# Inserted\n\n", src: "" }),
    ).toBe(false)
    expect(
      canReusePendingBlock({ mode: "code", raw: "```ts\none" }, { mode: "code", raw: "```ts\none two", src: "" }),
    ).toBe(true)
    expect(canReusePendingBlock({ mode: "live", raw: "partial" }, { mode: "live", raw: "partial text", src: "" })).toBe(
      true,
    )
    expect(canReusePendingBlock({ mode: "code", raw: "```ts\none" }, { mode: "live", raw: "one", src: "" })).toBe(false)
  })

  test("appends plain code deltas without reprojecting frozen blocks", () => {
    const previous = project(undefined, "# Plan\n\n```ts\nconst one = 1\n", true)
    const next = project(previous, `${previous.text}const two = 2\n`, true)

    expect(next.blocks[0]).toBe(previous.blocks[0])
    expect(next.blocks.at(-1)).toEqual({
      raw: "```ts\nconst one = 1\nconst two = 2\n",
      src: "const one = 1\nconst two = 2\n",
      mode: "code",
      language: "ts",
    })
  })

  test("finalizes only the live tail when streaming stops", () => {
    const live = project(undefined, "# Plan\n\nFinished paragraph.\n\n- final item", true)
    const final = project(live, live.text, false)

    expect(final.blocks[0]).toBe(live.blocks[0])
    expect(final.blocks[1]).toBe(live.blocks[1])
    expect(final.blocks[2]).toEqual({ raw: "- final item", src: "- final item", mode: "full" })
  })

  test("catches up paced text before finalizing", () => {
    const live = project(undefined, "# Plan\n\nFinished paragraph.\n\n- final", true)
    const final = project(live, `${live.text} item`, false)

    expect(canReusePendingBlock(live.blocks[0], final.blocks[0]!)).toBe(true)
    expect(canReusePendingBlock(live.blocks[1], final.blocks[1]!)).toBe(true)
    expect(final.blocks[2]).toEqual({ raw: "- final item", src: "- final item", mode: "full" })
  })

  test("completes an open code block when streaming stops", () => {
    const live = project(undefined, "```ts\nconst value = 1", true)
    const final = project(live, live.text, false)

    expect(final.blocks).toEqual([
      {
        raw: "```ts\nconst value = 1",
        src: "const value = 1",
        mode: "code",
        language: "ts",
        complete: true,
      },
    ])
  })

  test("does not add a blank line before the first streamed code", () => {
    const previous = project(undefined, "```ts\n", true)
    const next = project(previous, `${previous.text}const x = 1`, true)

    expect(next.blocks.at(-1)).toEqual({
      raw: "```ts\nconst x = 1",
      src: "const x = 1",
      mode: "code",
      language: "ts",
    })
  })

  test("closes code fences split across provider deltas", () => {
    const open = project(undefined, "```ts\nconst x = 1\n", true)
    const one = project(open, `${open.text}\``, true)
    const two = project(one, `${one.text}\``, true)
    const closed = project(two, `${two.text}\``, true)
    const prose = project(closed, `${closed.text}\nafter`, true)

    expect(closed.blocks.at(-1)).toEqual({
      raw: "```ts\nconst x = 1\n```",
      src: "const x = 1",
      mode: "code",
      language: "ts",
      complete: true,
    })
    expect(prose.blocks).toEqual([
      { raw: "```ts\nconst x = 1\n```\n", src: "const x = 1", mode: "code", language: "ts", complete: true },
      { raw: "after", src: "after", mode: "live" },
    ])
  })

  test("closes tilde fences split across provider deltas", () => {
    const open = project(undefined, "~~~ts\nconst x = 1\n", true)
    const one = project(open, `${open.text}~`, true)
    const two = project(one, `${one.text}~`, true)
    const closed = project(two, `${two.text}~`, true)

    expect(closed.blocks.at(-1)).toEqual({
      raw: "~~~ts\nconst x = 1\n~~~",
      src: "const x = 1",
      mode: "code",
      language: "ts",
      complete: true,
    })
  })
})
