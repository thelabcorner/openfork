import { expect, test } from "bun:test"
import type { SessionStatus } from "@opencode-ai/sdk/v2/client"
import { createMemo, createRoot } from "solid-js"
import { createStore } from "solid-js/store"
import { sessionStatusIsWorking } from "@/utils/session-status"
import { previewSparseSummary, samePreviewSummary } from "./session-preview-summary"

const status = (type: SessionStatus["type"]) => ({ type }) as SessionStatus

test("sparse summary preserves waiting > working > paused with duplicate group membership", () => {
  const weights = new Map([["a", 3], ["b", 1], ["c", 2], ["d", 4]])
  const input = {
    weights,
    statuses: { a: status("busy"), b: status("retry"), c: status("busy"), unrelated: status("busy") },
    paused: { c: true },
    permissions: { a: [{}], d: [{}], unrelated: [{}] },
    questions: { b: [{}], d: [{}], unknown: [{}] },
  }
  expect(previewSparseSummary(input)).toEqual({ running: 0, waiting: 8 })
  expect(previewSparseSummary({
    ...input, permissions: { d: [{}] }, questions: {},
  })).toEqual({ running: 4, waiting: 4 })
  expect(previewSparseSummary({
    ...input, permissions: {}, questions: {}, paused: {},
  })).toEqual({ running: 6, waiting: 0 })
  expect(previewSparseSummary({
    ...input, statuses: {}, permissions: {}, questions: {},
  })).toEqual({ running: 0, waiting: 0 })
})

test("randomized sparse summaries match legacy per-member status calculation", () => {
  let seed = 309_873
  const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
  const names = Array.from({ length: 300 }, (_, i) => `ses_${i}`)
  for (let trial = 0; trial < 350; trial++) {
    const weights = new Map<string, number>()
    for (let i = 0; i < 180; i++) {
      const id = names[random() % names.length]!
      weights.set(id, (weights.get(id) ?? 0) + 1)
    }
    const statuses: Record<string, SessionStatus> = {}
    const paused: Record<string, boolean> = {}
    const permissions: Record<string, unknown[]> = {}
    const questions: Record<string, unknown[]> = {}
    for (const id of names) {
      const value = random() % 7
      if (value === 0) statuses[id] = status("busy")
      if (value === 1) statuses[id] = status("retry")
      if (value === 2) statuses[id] = status("idle")
      if (random() % 29 === 0) paused[id] = true
      if (random() % 23 === 0) permissions[id] = [{}]
      if (random() % 31 === 0) questions[id] = [{}]
    }
    let running = 0
    let waiting = 0
    for (const [id, count] of weights) {
      if (permissions[id]?.length || questions[id]?.length) {
        waiting += count
      } else if (!paused[id] && sessionStatusIsWorking(statuses[id]?.type)) {
        running += count
      }
    }
    expect(previewSparseSummary({ weights, statuses, paused, permissions, questions })).toEqual({ running, waiting })
  }
})

test("sparse summary observes new status/attention keys and suppresses semantically equal outputs", () => {
  createRoot((dispose) => {
    const [data, setData] = createStore({
      statuses: {} as Record<string, SessionStatus | undefined>,
      paused: {} as Record<string, boolean | undefined>,
      permissions: {} as Record<string, unknown[] | undefined>,
      questions: {} as Record<string, unknown[] | undefined>,
    })
    const weights = new Map([["active", 2], ["other", 1]])
    let computations = 0
    const current = createMemo(() => {
      computations++
      return previewSparseSummary({
        weights, statuses: data.statuses, paused: data.paused,
        permissions: data.permissions, questions: data.questions,
      })
    }, undefined, { equals: samePreviewSummary })
    try {
      expect(current()).toEqual({ running: 0, waiting: 0 })
      const idle = current()
      setData("statuses", "unrelated", status("busy"))
      expect(current()).toBe(idle)
      setData("statuses", "active", status("busy"))
      expect(current()).toEqual({ running: 2, waiting: 0 })
      setData("questions", "active", [{}])
      expect(current()).toEqual({ running: 0, waiting: 2 })
      setData("paused", "active", true)
      expect(current()).toEqual({ running: 0, waiting: 2 })
      setData("questions", "active", [])
      expect(current()).toEqual({ running: 0, waiting: 0 })
      setData("statuses", "other", status("retry"))
      expect(current()).toEqual({ running: 1, waiting: 0 })
      setData("permissions", "other", [{}])
      expect(current()).toEqual({ running: 0, waiting: 1 })
      expect(computations).toBeGreaterThanOrEqual(6)
    } finally {
      dispose()
    }
  })
})