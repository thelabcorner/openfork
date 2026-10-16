import { expect, test } from "bun:test"
import { abortableProviderIterable } from "../../src/session/llm/abortable-provider-iterable"

test("ordinary completed iterator preserves all streamed values without premature abort", async () => {
  const abort = new AbortController()
  async function* source() {
    yield "first"
    yield "second"
  }
  const values: string[] = []
  for await (const part of abortableProviderIterable(source(), abort, 10)) values.push(part)
  expect(values).toEqual(["first", "second"])
  expect(abort.signal.aborted).toBe(false)
})

test("early iteration exit aborts transport before delegated SDK return", async () => {
  const abort = new AbortController()
  let sawAbort = false
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      let count = 0
      return {
        next: async () => ({ done: false, value: ++count }),
        return: async () => {
          sawAbort = abort.signal.aborted
          return { done: true, value: undefined }
        },
      }
    },
  }
  const values: number[] = []
  for await (const value of abortableProviderIterable(source, abort)) {
    values.push(value)
    break
  }
  expect(values).toEqual([1])
  expect(sawAbort).toBe(true)
  expect(abort.signal.aborted).toBe(true)
})

test("repeated return does not execute the upstream cleanup twice", async () => {
  const abort = new AbortController()
  let closes = 0
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: "x" }),
        return: async () => {
          closes++
          return { done: true, value: undefined }
        },
      }
    },
  }
  const iter = abortableProviderIterable(source, abort)[Symbol.asyncIterator]()
  await iter.next()
  await iter.return?.()
  await iter.return?.()
  expect(closes).toBe(1)
})

test("stuck upstream return is bounded without an unhandled rejection", async () => {
  const abort = new AbortController()
  let rejectLate!: (reason: unknown) => void
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: "x" }),
        return: () => new Promise((_, reject) => { rejectLate = reject }),
      }
    },
  }
  const iter = abortableProviderIterable(source, abort, 15)[Symbol.asyncIterator]()
  await iter.next()
  const started = performance.now()
  expect((await iter.return?.())?.done).toBe(true)
  expect(performance.now() - started).toBeLessThan(300)
  expect(abort.signal.aborted).toBe(true)
  rejectLate(new Error("late SDK return failed"))
  await Promise.resolve()
})

test("provider abort cleanup rejection cannot override an already completed response", async () => {
  const abort = new AbortController()
  const source: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => ({ done: false, value: "finished" }),
        return: async () => { throw new DOMException("aborted during close", "AbortError") },
      }
    },
  }
  const parts: string[] = []
  for await (const part of abortableProviderIterable(source, abort, 10)) {
    parts.push(part)
    break
  }
  expect(parts).toEqual(["finished"])
  expect(abort.signal.aborted).toBe(true)
})
