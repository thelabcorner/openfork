import { describe, expect, test } from "bun:test"
import {
  hasInjectionStructure,
  injectionAttributeTone,
  injectionContentPreview,
  injectionContentTone,
  injectionTagPresentation,
  parseInjectionContent,
  type InjectionNode,
} from "./system-injection-content"

function element(
  nodes: readonly InjectionNode[],
  tag: string,
): Extract<InjectionNode, { kind: "element" }> | undefined {
  for (const node of nodes) {
    if (node.kind !== "element") continue
    if (node.tag === tag) return node
    const nested = element(node.children, tag)
    if (nested) return nested
  }
  return undefined
}

const TASK = [
  '<task id="ses_f3485c087ffeta1Ca9qg5AzTer" state="completed">',
  "<summary>Background task completed: Harden demo static paths</summary>",
  "<task_result>",
  "Implemented the static-file boundary hardening in the two requested files.",
  "",
  "- **`webseal-poc/server/demo-server.mjs`** — Canonicalizes the configured dist root.",
  "",
  "**Root cause:** The previous containment check examined the lexical path only.",
  "</task_result>",
  "</task>",
].join("\n")

describe("parseInjectionContent", () => {
  test("lifts the task envelope into nested elements", () => {
    const nodes = parseInjectionContent(TASK)
    expect(nodes).toHaveLength(1)
    const task = nodes[0]
    expect(task?.kind).toBe("element")
    if (task?.kind !== "element") return
    expect(task.tag).toBe("task")
    expect(task.attributes).toEqual([
      { name: "id", value: "ses_f3485c087ffeta1Ca9qg5AzTer" },
      { name: "state", value: "completed" },
    ])
    expect(task.children.map((child) => (child.kind === "element" ? child.tag : "#text"))).toEqual([
      "summary",
      "task_result",
    ])
  })

  test("keeps markdown bodies byte-identical for the markdown renderer", () => {
    const result = element(parseInjectionContent(TASK), "task_result")
    expect(result?.text).toContain("- **`webseal-poc/server/demo-server.mjs`**")
    expect(result?.text).toContain("**Root cause:**")
    expect(result?.text.startsWith("Implemented")).toBe(true)
    expect(result?.text.endsWith("lexical path only.")).toBe(true)
  })

  test("decodes producer escaping on single-line bodies and attributes", () => {
    const nodes = parseInjectionContent(
      ['<task id="a&amp;b" state="error">', "<summary>failed on &lt;input&gt;</summary>", "</task>"].join("\n"),
    )
    const task = nodes[0]
    if (task?.kind !== "element") throw new Error("expected element")
    expect(task.attributes[0]).toEqual({ name: "id", value: "a&b" })
    expect(element(nodes, "summary")?.text).toBe("failed on <input>")
  })

  test("leaves multi-line bodies undecoded because producers never escape them", () => {
    const nodes = parseInjectionContent(["<preview>", "grep 'a&amp;b' &lt;file", "</preview>"].join("\n"))
    expect(element(nodes, "preview")?.text).toBe("grep 'a&amp;b' &lt;file")
  })

  test("plain reminders stay a single text node", () => {
    const text = "You are in plan mode.\n\nDo not edit files. Use `Vec<T>` and a < b freely."
    const nodes = parseInjectionContent(text)
    expect(nodes).toEqual([{ kind: "text", text }])
    expect(hasInjectionStructure(nodes)).toBe(false)
  })

  test("an unclosed tag is prose, not an envelope", () => {
    const nodes = parseInjectionContent("<task>\nno close here")
    expect(nodes).toHaveLength(1)
    expect(nodes[0]?.kind).toBe("text")
  })

  test("ignores tags inside fenced code", () => {
    const nodes = parseInjectionContent(
      ["Run this:", "```html", "<summary>", "inner", "</summary>", "```", "Done."].join("\n"),
    )
    expect(hasInjectionStructure(nodes)).toBe(false)
  })

  test("handles same-tag nesting without closing on the inner tag", () => {
    const nodes = parseInjectionContent(["<note>", "<note>", "inner", "</note>", "outer tail", "</note>"].join("\n"))
    const outer = nodes[0]
    if (outer?.kind !== "element") throw new Error("expected element")
    expect(outer.text).toBe("<note>\ninner\n</note>\nouter tail")
    expect(element(outer.children, "note")?.text).toBe("inner")
  })

  test("reads self-closing tags as attribute-only elements", () => {
    const nodes = parseInjectionContent('<checkpoint id="cp_1" />')
    const node = nodes[0]
    if (node?.kind !== "element") throw new Error("expected element")
    expect(node.tag).toBe("checkpoint")
    expect(node.children).toEqual([])
    expect(node.attributes).toEqual([{ name: "id", value: "cp_1" }])
  })

  test("keeps text that surrounds an envelope", () => {
    const nodes = parseInjectionContent(["lead in", "<note>", "body", "</note>", "tail"].join("\n"))
    expect(nodes.map((node) => node.kind)).toEqual(["text", "element", "text"])
    expect(nodes[0]).toEqual({ kind: "text", text: "lead in" })
    expect(nodes[2]).toEqual({ kind: "text", text: "tail" })
  })
})

describe("injectionContentPreview", () => {
  test("prefers the declared summary over the machine open tag", () => {
    expect(injectionContentPreview(parseInjectionContent(TASK))).toBe(
      "Background task completed: Harden demo static paths",
    )
  })

  test("falls back to the first real prose line, stripped of markdown syntax", () => {
    const nodes = parseInjectionContent(["<task_result>", "## **Heading** here", "body", "</task_result>"].join("\n"))
    expect(injectionContentPreview(nodes)).toBe("Heading here")
  })

  test("is empty when there is nothing to say", () => {
    expect(injectionContentPreview(parseInjectionContent('<task id="x" state="running">\n</task>'))).toBe("")
  })
})

describe("tone", () => {
  test("maps status-shaped attributes to tones", () => {
    expect(injectionAttributeTone({ name: "state", value: "completed" })).toBe("success")
    expect(injectionAttributeTone({ name: "status", value: "error" })).toBe("danger")
    expect(injectionAttributeTone({ name: "state", value: "running" })).toBe("info")
    expect(injectionAttributeTone({ name: "state", value: "weird" })).toBe("neutral")
    expect(injectionAttributeTone({ name: "id", value: "completed" })).toBeUndefined()
  })

  test("escalates the segment tone to the most severe signal present", () => {
    expect(injectionContentTone(parseInjectionContent(TASK))).toBe("success")
    expect(
      injectionContentTone(
        parseInjectionContent(['<task id="x" state="completed">', "<task_error>", "boom", "</task_error>", "</task>"].join("\n")),
      ),
    ).toBe("danger")
    expect(injectionContentTone(parseInjectionContent("plain text"))).toBeUndefined()
  })
})

describe("injectionTagPresentation", () => {
  test("knows the first-party envelope vocabulary", () => {
    expect(injectionTagPresentation("task").role).toBe("frame")
    expect(injectionTagPresentation("summary").role).toBe("lead")
    expect(injectionTagPresentation("preview")).toMatchObject({ label: "Output", body: "pre" })
    expect(injectionTagPresentation("task_error")).toMatchObject({ tone: "danger" })
  })

  test("degrades unknown tags to a readable labelled section", () => {
    expect(injectionTagPresentation("scripts_summary")).toEqual({
      label: "Scripts summary",
      role: "section",
      body: "markdown",
    })
  })
})
