import { expect, test } from "bun:test"
import {
  applyMarkdownProjectionPatch,
  applyMarkdownWorkerResponse,
  diffMarkdownProjection,
  markdownBlockKey,
  markdownHighlightRequest,
  markdownParseRequest,
  shouldReleaseMarkdownWorkerState,
} from "./markdown-worker-protocol"
import type { Projection } from "./markdown-stream"

const token = (content: string): [string, string] => [content, ""]
const response = (id: number, reset: boolean, stable: [string, string][], unstable: [string, string][]) => ({
  type: "highlight" as const,
  id,
  key: "code",
  language: "typescript",
  reset,
  stable,
  unstable,
})

test("accumulates stable worker tokens and replaces the unstable tail", () => {
  const first = applyMarkdownWorkerResponse(undefined, {
    type: "highlight",
    id: 1,
    key: "code",
    language: "typescript",
    reset: true,
    stable: [token("one\n")],
    unstable: [token("tw")],
  })
  const second = applyMarkdownWorkerResponse(first, {
    type: "highlight",
    id: 2,
    key: "code",
    language: "typescript",
    reset: false,
    stable: [token("two\n")],
    unstable: [token("three")],
  })

  expect(second.stable.map((item) => item[0])).toEqual(["one\n", "two\n"])
  expect(second.unstable.map((item) => item[0])).toEqual(["three"])
  expect(second.language).toBe("typescript")
})

test("increments generation only when the worker resets token identity", () => {
  const first = applyMarkdownWorkerResponse(undefined, response(1, true, [["const", ""]], []))
  const append = applyMarkdownWorkerResponse(first, response(2, false, [[" x", ""]], []))
  const replacement = applyMarkdownWorkerResponse(append, response(3, true, [["let y", ""]], []))
  expect([first.generation, append.generation, replacement.generation]).toEqual([1, 1, 2])
})

test("ignores stale worker responses and resets replacement streams", () => {
  const current = { id: 2, generation: 1, language: "typescript", stable: [token("current")], unstable: [] }
  expect(
    applyMarkdownWorkerResponse(current, {
      type: "highlight",
      id: 1,
      key: "code",
      language: "typescript",
      reset: false,
      stable: [token("stale")],
      unstable: [],
    }),
  ).toBe(current)

  expect(
    applyMarkdownWorkerResponse(current, {
      type: "highlight",
      id: 3,
      key: "code",
      language: "typescript",
      reset: true,
      stable: [token("replacement")],
      unstable: [],
    }).stable.map((item) => item[0]),
  ).toEqual(["replacement"])
})

test("releases only the latest completed worker state", () => {
  expect(shouldReleaseMarkdownWorkerState(true, 4, 4)).toBe(true)
  expect(shouldReleaseMarkdownWorkerState(true, 5, 4)).toBe(false)
  expect(shouldReleaseMarkdownWorkerState(false, 4, 4)).toBe(false)
})

test("prefixes pending and dispatched block keys with the component owner", () => {
  expect(markdownBlockKey("owner", "message", 2, "code")).toBe("owner:message:2:code")
  expect(markdownBlockKey("owner", undefined, 2, "code")).toBe("owner:block:2")
})

test("streaming code sends only an append suffix after an acknowledged source", () => {
  const request = markdownHighlightRequest(
    { type: "highlight", id: 2, key: "code", text: "const answer = 42", language: "typescript" },
    { text: "const answer = ", language: "typescript" },
  )
  expect(request).toEqual({
    type: "highlight",
    id: 2,
    key: "code",
    language: "typescript",
    baseLength: 15,
    append: "42",
  })
})

test("live markdown parse sends only the append suffix after an acknowledged source", () => {
  expect(markdownParseRequest(
    { type: "parse", id: 2, key: "live", text: "hello world" },
    "hello ",
  )).toEqual({ type: "parse", id: 2, key: "live", baseLength: 6, append: "world" })
})

test("live markdown parse resets when source is replaced", () => {
  const request = markdownParseRequest(
    { type: "parse", id: 3, key: "live", text: "replacement" },
    "hello world",
  )
  expect("reset" in request && request.reset).toBe(true)
  expect("text" in request ? request.text : undefined).toBe("replacement")
})

test("streaming code resets on replacement/language change and completion", () => {
  const base = { text: "const answer = ", language: "typescript" }
  const replacement = markdownHighlightRequest(
    { type: "highlight", id: 3, key: "code", text: "let answer = 42", language: "typescript" },
    base,
  )
  expect("reset" in replacement && replacement.reset).toBe(true)

  const language = markdownHighlightRequest(
    { type: "highlight", id: 4, key: "code", text: "const answer = 42", language: "javascript" },
    base,
  )
  expect("reset" in language && language.reset).toBe(true)

  const complete = markdownHighlightRequest(
    { type: "highlight", id: 5, key: "code", text: "const answer = 42", language: "typescript", complete: true },
    { text: "const answer = ", language: "typescript" },
  )
  expect("reset" in complete && complete.reset).toBe(true)
  expect("text" in complete ? complete.text : undefined).toBe("const answer = 42")
})

test("projects only the changed block suffix and reconstructs it losslessly", () => {
  const frozen = { raw: "# title\n\n", src: "# title\n\n", mode: "full" as const }
  const previous: Projection = {
    text: "# title\n\nhel",
    blocks: [frozen, { raw: "hel", src: "hel", mode: "live" }],
  }
  const next: Projection = {
    text: "# title\n\nhello",
    blocks: [frozen, { raw: "hello", src: "hello", mode: "live" }],
  }
  const patch = diffMarkdownProjection(previous, next)
  expect(patch.keep).toBe(1)
  expect(patch.blocks).toHaveLength(1)
  expect(applyMarkdownProjectionPatch(previous, next.text, patch)).toEqual(next)
})

test("full projection reset does not depend on host prefix state", () => {
  const next: Projection = { text: "replacement", blocks: [{ raw: "replacement", src: "replacement", mode: "live" }] }
  const patch = diffMarkdownProjection(undefined, next)
  expect(patch.keep).toBe(0)
  expect(applyMarkdownProjectionPatch(undefined, next.text, patch)).toEqual(next)
})
