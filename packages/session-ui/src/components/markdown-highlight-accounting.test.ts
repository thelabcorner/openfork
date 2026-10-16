import { expect, test } from "bun:test"
import type { MarkdownToken } from "./markdown-worker-protocol"
import { highlightTokenBytes, nextHighlightStateBytes } from "./markdown-highlight-accounting"

test("accounts for only incremental stable additions and replaced unstable suffixes", () => {
  const prefix: MarkdownToken[] = [["const", "color:red"], [" x", ""]]
  const unstable: MarkdownToken[] = [[" = 1", "color:blue"]]
  const initial = { reset: true, stable: prefix, unstable }
  const first = nextHighlightStateBytes(undefined, undefined, initial)
  expect(first).toBe(highlightTokenBytes(prefix) + highlightTokenBytes(unstable))
  const second = {
    reset: false,
    stable: [] as MarkdownToken[],
    unstable: [[" = 1234", "color:blue"]] as MarkdownToken[],
  }
  const secondBytes = nextHighlightStateBytes(initial, first, second)
  expect(secondBytes).toBe(highlightTokenBytes(prefix) + highlightTokenBytes(second.unstable))
  const third = { reset: false, stable: [[" = 1234", "color:blue"]] as MarkdownToken[], unstable: [[";", ""]] as MarkdownToken[] }
  expect(nextHighlightStateBytes(second, secondBytes, third)).toBe(
    highlightTokenBytes([...prefix, ...third.stable, ...third.unstable]),
  )
})

test("resets and missing prior state use the response alone", () => {
  const prior = { unstable: [["previous", ""]] as MarkdownToken[] }
  const response = { reset: true, stable: [["replacement", ""]] as MarkdownToken[], unstable: [] as MarkdownToken[] }
  expect(nextHighlightStateBytes(prior, 1_000_000, response)).toBe(highlightTokenBytes(response.stable))
  expect(nextHighlightStateBytes(undefined, undefined, { ...response, reset: false })).toBe(highlightTokenBytes(response.stable))
})
