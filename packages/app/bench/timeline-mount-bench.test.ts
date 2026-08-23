/**
 * Manual benchmark: row reconciliation ceiling for the session-timeline
 * switch frame (NOT part of test discovery; run explicitly:
 *   bun test --conditions=browser --preload ./happydom.ts ./bench/timeline-mount-bench.test.ts
 *
 * Bounds the RECYCLABLE share of the per-switch row-mount cost by racing:
 *   Arm A (status quo): <For> keyed by globally-unique row keys -- a session
 *     swap changes every key, so Solid disposes + recreates all row subtrees.
 *   Arm B (candidate):  <Index> position-keyed -- the same swap keeps every
 *     subtree and rewrites content in place through accessors.
 *
 * VERIFIED against the installed client dist (solid.js):
 *   - mapArray.mapper passes the RAW item to single-arg For children;
 *   - indexArray.mapper passes a real signal accessor to Index children and
 *     updates slots in place (`signals[i](...)`);
 *   - For/Index return LAZY memos -- in JSX, insert() tracks them; standalone,
 *     a tracking renderEffect reader is required or reconciliation stalls;
 *   - effect RE-runs scheduled inside a createRoot body are deferred until the
 *     body completes (runUpdates wait-flag): all swaps therefore happen AFTER
 *     the root returns, matching how real event handlers run.
 *
 * Leaf content is deliberately plain DOM (paragraphs/class lists, no markdown
 * parser): markdown parse+render happens in BOTH arms for the new text either
 * way, so excluding it from both does not bias the delta -- what it isolates
 * is exactly the part recycling can claim (component scaffolding, element
 * creation, insertion, disposal).
 *
 * CAVEAT: happy-dom per-op DOM cost generally OVERSTATES Chrome, so absolute
 * ms here are pessimistic; the A-B RATIO is the decision signal.
 */
import { describe, expect, test } from "bun:test"
import { batch, createComponent, createRenderEffect, createRoot, createSignal, For, Index, type Accessor } from "solid-js"
import h from "solid-js/h"

type RowPayload = {
  key: string
  top: number
  size: number
  index: number
  paragraphs: string[]
  tool?: string
}

const LOREM =
  "The quick brown fox jumps over the lazy dog while the village sleeps and the river carries autumn leaves past the old mill wheel. "

function makeSession(prefix: string, rowCount: number, heaviness = 1): RowPayload[] {
  const rows: RowPayload[] = []
  let top = 0
  for (let i = 0; i < rowCount; i++) {
    const paragraphCount = Math.round((2 + (i % 4)) * heaviness)
    const paragraphs = Array.from(
      { length: paragraphCount },
      (_, p) =>
        `${prefix} turn ${i} para ${p}: ${LOREM.repeat(3 + ((i + p) % 5)).slice(
          0,
          Math.round((320 + ((i * 37 + p * 91) % 900)) * heaviness),
        )}`,
    )
    const tool = i % 5 === 2 ? `${prefix} ran tool edit on src/foo_${i}.ts (+42 -17)` : undefined
    const size = 120 + paragraphCount * 66 + (tool ? 40 : 0)
    rows.push({ key: `${prefix}-row-${i}`, top, size, index: i, paragraphs, tool })
    top += size + 12
  }
  return rows
}

/** Mirrors VirtualTimelineRow's wrapper shape + typical leaf content. */
function RowSubtree(payload: Accessor<RowPayload>): HTMLElement {
  return h(
    "div",
    {
      "data-timeline-key": () => payload().key,
      // h idiom: reactive style must be ONE function prop returning the object
      // (web style() does not unwrap per-key functions).
      style: () => ({
        position: "absolute",
        left: "0",
        width: "100%",
        top: `${payload().top - 64}px`,
        height: `${payload().size}px`,
        overflow: "clip",
      }),
    },
    h("div", { "data-index": () => String(payload().index) },
      h("div", { class: "w-full px-4 md:px-5", "data-slot": "session-turn-message-container" },
        h("div", { "data-component": "session-turn", class: "min-w-0 w-full relative" },
          () => {
            const current = payload()
            const children: Node[] = []
            if (current.tool) {
              children.push(
                h("div", { class: "flex items-center gap-1.5 rounded-[6px] border px-2 py-1 text-12-medium", "data-slot": "tool-header" },
                  h("span", {}, current.tool)(),
                ),
              )
            }
            for (let p = 0; p < current.paragraphs.length; p++) {
              children.push(
                h("p", { class: "text-14-regular leading-[22.4px] whitespace-pre-wrap break-words my-2" },
                  h("span", {}, current.paragraphs[p]!)(),
                ),
              )
            }
            return children
          },
        )(),
      )(),
    )(),
  )() as HTMLElement
}

/**
 * For/Index return lazy memos: without a tracked reader their reconciliation
 * never runs outside JSX. Mirror what insert()/insertExpression() do in
 * compiled output: keep the memo subscribed AND re-sync the parent's children
 * whenever the mapped node list changes.
 * The runtime MUTATES mapArray's mapped array in place, so the previous list
 * must be a snapshot (effect prev-value chain + copy) — holding the live
 * array makes the diff compare the list against itself.
 */
function trackInsert(parent: HTMLElement, memo: () => readonly Node[]): void {
  createRenderEffect(((prev: readonly Node[]) => {
    const next = memo()
    const previous = [...prev]
    for (const node of previous) if (!next.includes(node)) node.remove()
    for (const node of next) if (!previous.includes(node)) parent.append(node)
    return [...next]
  }) as (prev?: readonly Node[]) => readonly Node[], [])
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

function race(name: string, rowCount: number, iterations: number, heaviness = 1) {
  const sessionA = makeSession("alpha", rowCount, heaviness)
  const sessionB = makeSession("beta", rowCount, heaviness)
  const byKeyA = new Map(sessionA.map((row) => [row.key, row]))
  const byKeyB = new Map(sessionB.map((row) => [row.key, row]))

  // Build both arms inside a root; ALL swaps happen after it returns (outside
  // any owner context), so effect re-runs flush synchronously like they do in
  // real event handlers.
  const harness = createRoot((dispose) => {
    // Arm A: <For> keyed by row key (status quo). Single-arg For children
    // receive the RAW item in this dist -- payload lookup is a plain closure
    // over that constant key.
    const [keys, setKeys] = createSignal(sessionA.map((row) => row.key))
    const containerFor = h("div", { style: "position: relative" })() as HTMLElement
    document.body.append(containerFor)
    trackInsert(
      containerFor,
      createComponent(For, {
        get each() {
          return keys()
        },
        children: (key: Accessor<string>) => {
          const rawKey = key as unknown as string
          return RowSubtree(() => byKeyA.get(rawKey) ?? byKeyB.get(rawKey)!)
        },
      }) as unknown as () => readonly Node[],
    )

    // Arm B: <Index> position-keyed (recycling candidate).
    const [rows, setRows] = createSignal(sessionA)
    const containerIndex = h("div", { style: "position: relative" })() as HTMLElement
    document.body.append(containerIndex)
    trackInsert(
      containerIndex,
      createComponent(Index, {
        get each() {
          return rows()
        },
        children: (payload: Accessor<RowPayload>) => RowSubtree(payload),
      }) as unknown as () => readonly Node[],
    )

    expect(containerFor.querySelectorAll("[data-timeline-key]").length).toBe(rowCount)
    expect(containerIndex.querySelectorAll("[data-timeline-key]").length).toBe(rowCount)

    return { dispose, containerFor, containerIndex, setKeys, setRows }
  })
  const { dispose, containerFor, containerIndex, setKeys, setRows } = harness

  // Sanity: a swap actually rewrites content (arm B in place, arm A rebuild).
  setKeys(sessionB.map((row) => row.key))
  setRows(sessionB)
  expect(containerFor.querySelectorAll("[data-timeline-key]")[0]!.getAttribute("data-timeline-key")).toMatch(/^beta-row-0$/)
  expect(containerIndex.querySelectorAll("[data-timeline-key]")[0]!.getAttribute("data-timeline-key")).toMatch(/^beta-row-0$/)
  expect(containerIndex.textContent).toContain("beta turn 0 para")

  const samples: Record<string, number[]> = { for: [], index: [] }

  // Warmup (JIT + happy-dom caches), then alternate A/B/A/B to cancel drift.
  for (let i = 0; i < 5; i++) {
    batch(() => setKeys(i % 2 === 0 ? sessionB.map((row) => row.key) : sessionA.map((row) => row.key)))
    batch(() => setRows(i % 2 === 0 ? sessionB : sessionA))
  }
  for (let i = 0; i < iterations; i++) {
    const toB = i % 2 === 0
    const startFor = performance.now()
    batch(() => setKeys(toB ? sessionB.map((row) => row.key) : sessionA.map((row) => row.key)))
    samples.for.push(performance.now() - startFor)
    const startIndex = performance.now()
    batch(() => setRows(toB ? sessionB : sessionA))
    samples.index.push(performance.now() - startIndex)
  }

  const forMs = median(samples.for)
  const indexMs = median(samples.index)
  console.log(
    `[${name}] ${rowCount} rows | For dispose+create ${forMs.toFixed(2)} ms | Index in-place ${indexMs.toFixed(2)} ms | recyclable delta ${(forMs - indexMs).toFixed(2)} ms`,
  )
  containerFor.remove()
  containerIndex.remove()
  dispose()
}

describe("timeline row reconciliation ceiling", () => {
  test("For remount vs Index in-place swap (real DOM subtrees)", () => {
    console.log("\n--- row reconciliation ceiling (happy-dom; ratio is the signal) ---")
    race("viewport", 13, 40)
    race("viewport+overscan", 25, 40)
    race("viewport+overscan (repeat)", 25, 40)
    race("heavy rows (3x content)", 25, 25, 3)
    race("heavy rows (6x content)", 25, 15, 6)
  })
})
