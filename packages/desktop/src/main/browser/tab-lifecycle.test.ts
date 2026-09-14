import { expect, test } from "bun:test"
import { BrowserTabLifecycle } from "./tab-lifecycle"

test("logical close blocks late renderer registration", () => {
  const lifecycle = new BrowserTabLifecycle()
  const generation = lifecycle.request("tab-a")
  expect(lifecycle.canAttach("tab-a", generation)).toBe(true)
  expect(lifecycle.markAttached("tab-a", generation)).toBe(true)
  expect(lifecycle.beginClose("tab-a", generation)?.phase).toBe("closing")
  expect(lifecycle.canAttach("tab-a", generation)).toBe(false)
  expect(lifecycle.finishClose("tab-a", generation)).toBe(true)
  expect(lifecycle.canAttach("tab-a", generation)).toBe(false)
})

test("presentation detach does not end the logical tab lifetime", () => {
  const lifecycle = new BrowserTabLifecycle()
  const generation = lifecycle.request("tab-a")
  lifecycle.markAttached("tab-a", generation)
  expect(lifecycle.markDetached("tab-a", generation)).toBe(true)
  expect(lifecycle.snapshot("tab-a")).toEqual({ generation, phase: "detached" })
  expect(lifecycle.canAttach("tab-a", generation)).toBe(true)
  expect(lifecycle.markAttached("tab-a", generation)).toBe(true)
})

test("re-created tab id rejects the prior lifetime generation", () => {
  const lifecycle = new BrowserTabLifecycle()
  const first = lifecycle.request("tab-a")
  lifecycle.beginClose("tab-a", first)
  lifecycle.finishClose("tab-a", first)
  const second = lifecycle.request("tab-a")
  expect(second).toBe(first + 1)
  expect(lifecycle.canAttach("tab-a", first)).toBe(false)
  expect(lifecycle.canAttach("tab-a", second)).toBe(true)
})

test("duplicate active requests are rejected instead of silently replacing authority", () => {
  const lifecycle = new BrowserTabLifecycle()
  lifecycle.request("tab-a")
  expect(() => lifecycle.request("tab-a")).toThrow("already has an active lifecycle")
})