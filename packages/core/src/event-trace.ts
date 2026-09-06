export * as EventTrace from "./event-trace"

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { xdgData } from "xdg-basedir"

/**
 * Phase-by-phase trace for the server event pipeline, written as JSONL to a
 * file for post-run analysis.
 *
 * Default ON: set `OPENCODE_EVENT_TRACE=0` (or false/off/no) to disable, and
 * `OPENCODE_EVENT_TRACE_DIR` to override the output directory (default
 * `<xdg-data>/opencode/log/event-trace`). One `trace-<pid>-<timestamp>.jsonl`
 * per process, rolled at 25 MiB keeping two rotated files.
 *
 * Cost discipline: the hot path records integer counter updates only. No
 * payload content is ever logged — ids, types, counts, sizes and durations.
 * File writes go through a buffered stream with a drop-rather-than-block
 * policy, so tracing can never stall the event loop it observes.
 */

const OFF = new Set(["0", "false", "off", "no"])
const MAX_LINE_BYTES = 4 * 1024
const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_ROTATED = 2
const MAX_HISTOGRAM_KEYS = 64
const MAX_RING = 256
const SUMMARY_MS = 15_000
const MAX_BUFFERED_BYTES = 1024 * 1024

const traceEnv = process.env.OPENCODE_EVENT_TRACE
let enabled = traceEnv === undefined ? true : !OFF.has(traceEnv.toLowerCase().trim())

let directory =
  process.env.OPENCODE_EVENT_TRACE_DIR ?? path.join(xdgData ?? path.join(os.tmpdir(), ".local", "share"), "opencode", "log", "event-trace")

const counters = new Map<string, number>()
const timings = new Map<string, { count: number; total: number; max: number }>()
const histograms = new Map<string, Map<string, number>>()
const ring: Array<Record<string, unknown>> = []
let droppedLines = 0
let stream: fs.WriteStream | undefined
let streamBytes = 0
let streamPath = ""
let fileDead = false
let summaryTimer: ReturnType<typeof setInterval> | undefined
let summaryAt = 0

function ensureStream() {
  if (!enabled || fileDead || stream) return
  try {
    fs.mkdirSync(directory, { recursive: true })
    const stamp = new Date().toISOString().replaceAll(":", "-").replace(".", "-")
    streamPath = path.join(directory, `trace-${process.pid}-${stamp}.jsonl`)
    streamBytes = 0
    stream = fs.createWriteStream(streamPath, { flags: "a" })
    stream.on("error", () => {
      fileDead = true
      stream = undefined
    })
  } catch {
    fileDead = true
    stream = undefined
  }
}

function rotate() {
  if (!streamPath) return
  try {
    stream?.close()
  } catch {
    // Rotation is best-effort; a failed close must not break tracing.
  }
  stream = undefined
  try {
    for (let index = MAX_ROTATED - 1; index >= 1; index--) {
      const older = `${streamPath}.${index}`
      if (fs.existsSync(older)) fs.renameSync(older, `${streamPath}.${index + 1}`)
    }
    if (fs.existsSync(streamPath)) fs.renameSync(streamPath, `${streamPath}.1`)
    try {
      fs.unlinkSync(`${streamPath}.${MAX_ROTATED + 1}`)
    } catch {
      // Missing file is the common case; anything else is not worth failing over.
    }
  } catch {
    // Keep tracing into the current file rather than losing the stream.
  }
}

function writeLine(line: string) {
  if (!enabled) return
  ensureStream()
  if (!stream || fileDead) return
  if (streamBytes > MAX_FILE_BYTES) rotate()
  if (!stream) return
  try {
    const buffered = (stream as unknown as { writableLength?: number }).writableLength ?? 0
    if (buffered > MAX_BUFFERED_BYTES || stream.write(line + "\n") === false) {
      droppedLines += 1
      return
    }
    streamBytes += line.length + 1
  } catch {
    droppedLines += 1
  }
}

function line(fields: Record<string, unknown>) {
  let text: string
  try {
    text = JSON.stringify({ t: Date.now(), pid: process.pid, ...fields })
  } catch {
    return
  }
  if (text.length > MAX_LINE_BYTES) text = text.slice(0, MAX_LINE_BYTES)
  writeLine(text)
}

function snapshot() {
  const timingOut: Record<string, { count: number; avgMs: number; maxMs: number }> = {}
  for (const [name, value] of timings) {
    timingOut[name] = {
      count: value.count,
      avgMs: value.count === 0 ? 0 : value.total / value.count,
      maxMs: value.max,
    }
  }
  const histogramOut: Record<string, Record<string, number>> = {}
  for (const [name, buckets] of histograms) {
    histogramOut[name] = Object.fromEntries(buckets)
  }
  return {
    counters: Object.fromEntries(counters),
    timings: timingOut,
    histograms: histogramOut,
    droppedLines,
    file: streamPath || undefined,
  }
}

function summarize() {
  if (!enabled) return
  const now = Date.now()
  const windowSec = summaryAt === 0 ? 0 : (now - summaryAt) / 1000
  summaryAt = now
  line({ phase: "summary", windowSec, ...snapshot() })
  counters.clear()
  timings.clear()
  histograms.clear()
}

function ensureTimer() {
  if (!enabled || summaryTimer !== undefined) return
  summaryTimer = setInterval(summarize, SUMMARY_MS)
  if (typeof (summaryTimer as unknown as { unref?: () => void }).unref === "function") {
    ;(summaryTimer as unknown as { unref: () => void }).unref()
  }
}

/** Integer counter increment. Safe to call on the publish hot path. */
export function count(name: string, amount = 1) {
  if (!enabled) return
  counters.set(name, (counters.get(name) ?? 0) + amount)
  ensureTimer()
}

/** Additive sum, e.g. bytes. Safe to call on the publish hot path. */
export function sum(name: string, amount: number) {
  if (!enabled || !(amount > 0)) return
  counters.set(name, (counters.get(name) ?? 0) + amount)
  ensureTimer()
}

/** Duration accumulator. Records count, mean and max; no per-sample retention. */
export function timing(name: string, ms: number) {
  if (!enabled || !(ms >= 0)) return
  const current = timings.get(name) ?? { count: 0, total: 0, max: 0 }
  current.count += 1
  current.total += ms
  if (ms > current.max) current.max = ms
  timings.set(name, current)
  ensureTimer()
}

/** Bounded key histogram; past 64 distinct keys everything lands in "other". */
export function histogram(name: string, key: string) {
  if (!enabled) return
  let buckets = histograms.get(name)
  if (!buckets) {
    buckets = new Map()
    histograms.set(name, buckets)
  }
  const short = key.length > 128 ? key.slice(0, 128) : key
  if (!buckets.has(short) && buckets.size >= MAX_HISTOGRAM_KEYS) {
    buckets.set("other", (buckets.get("other") ?? 0) + 1)
    return
  }
  buckets.set(short, (buckets.get(short) ?? 0) + 1)
  ensureTimer()
}

/**
 * One JSONL line for a rare event (overflow, gap, oversize, reconnect).
 * Never call per token — counters exist for the hot path.
 */
export function event(fields: Record<string, unknown>) {
  if (!enabled) return
  ring.push({ t: Date.now(), ...fields })
  if (ring.length > MAX_RING) ring.splice(0, ring.length - MAX_RING)
  line({ ...fields })
  ensureTimer()
}

/** Current window contents without resetting. Test and inspection seam. */
export function state() {
  return { ...snapshot(), recent: [...ring] }
}

/** Test seam: redirect output and reset all state. */
export function configure(options: { readonly directory?: string; readonly enabled?: boolean }) {
  if (options.directory !== undefined) directory = options.directory
  if (options.enabled !== undefined) enabled = options.enabled
  try {
    stream?.close()
  } catch {
    // Test reset must not throw on an already-closed stream.
  }
  stream = undefined
  streamBytes = 0
  streamPath = ""
  fileDead = false
  reset()
}

/** Test seam: clear counters without touching the output file. */
export function reset() {
  counters.clear()
  timings.clear()
  histograms.clear()
  ring.length = 0
  droppedLines = 0
  summaryAt = 0
}

/** Test seam: force one summary line now. */
export function flush() {
  summarize()
}
