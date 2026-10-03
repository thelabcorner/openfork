import type { MarkdownWorkPriority } from "./markdown-worker-admission"

export const MARKDOWN_FRAME_WORK_MAX_JOBS = 64
export const MARKDOWN_FRAME_WORK_MAX_BYTES = 8 * 1024 * 1024
export const MARKDOWN_FRAME_WORK_MAX_JOB_BYTES = 256 * 1024
export const MARKDOWN_FRAME_WORK_MAX_WAITERS = 256
export const MARKDOWN_FRAME_WORK_MAX_WAITING_BYTES = 64 * 1024 * 1024

type Work<T> = {
  key: string
  priority: MarkdownWorkPriority
  bytes: number
  order: number
  age: number
  current: () => boolean
  run: () => T
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export type MarkdownFrameWorkReservation = { key: string; bytes: number; id: number }
type ReservationWaiter = {
  key: string
  bytes: number
  current: () => boolean
  resolve: (reservation: MarkdownFrameWorkReservation) => void
  reject: (error: Error) => void
}

const queues: Record<MarkdownWorkPriority, Work<unknown>[]> = { background: [], visible: [], tail: [] }
const byKey = new Map<string, Work<unknown>>()
const reservations = new Map<string, MarkdownFrameWorkReservation>()
const reservationWaiters: ReservationWaiter[] = []
let bytes = 0
let reservedBytes = 0
let waitingBytes = 0
let order = 0
let nextReservationID = 0
let frame = 0
let scheduled = false
let activePriorityStreak = 0
let completed = 0

function remove(work: Work<unknown>, error: Error) {
  if (!byKey.delete(work.key)) return
  const queue = queues[work.priority]
  const index = queue.indexOf(work)
  if (index >= 0) queue.splice(index, 1)
  bytes -= work.bytes
  work.reject(error)
  promoteReservations()
}

function fits(bytesNeeded: number) {
  return (
    byKey.size + reservations.size < MARKDOWN_FRAME_WORK_MAX_JOBS &&
    bytes + reservedBytes + bytesNeeded <= MARKDOWN_FRAME_WORK_MAX_BYTES
  )
}

function makeReservation(key: string, bytesNeeded: number) {
  const reservation = { key, bytes: bytesNeeded, id: ++nextReservationID }
  reservations.set(key, reservation)
  reservedBytes += bytesNeeded
  return reservation
}

function promoteReservations() {
  for (let index = 0; index < reservationWaiters.length;) {
    const waiter = reservationWaiters[index]!
    if (!waiter.current()) {
      reservationWaiters.splice(index, 1)
      waitingBytes -= waiter.bytes
      waiter.reject(new DOMException("Markdown frame reservation was superseded", "AbortError"))
      continue
    }
    if (!fits(waiter.bytes)) {
      index++
      continue
    }
    reservationWaiters.splice(index, 1)
    waitingBytes -= waiter.bytes
    waiter.resolve(makeReservation(waiter.key, waiter.bytes))
  }
}

function releaseReservation(reservation: MarkdownFrameWorkReservation) {
  if (reservations.get(reservation.key) !== reservation) return
  reservations.delete(reservation.key)
  reservedBytes -= reservation.bytes
  promoteReservations()
}

/** Reserve bounded sanitizer capacity before materializing worker HTML. */
export function reserveMarkdownFrameWork(input: {
  key: string
  bytes: number
  current: () => boolean
}) {
  if (input.bytes > MARKDOWN_FRAME_WORK_MAX_JOB_BYTES)
    return Promise.reject<MarkdownFrameWorkReservation>(new Error("Markdown frame reservation exceeded its per-job byte bound"))
  const existing = reservations.get(input.key)
  if (existing) releaseReservation(existing)
  const queued = byKey.get(input.key)
  if (queued) remove(queued, new DOMException("Markdown frame work was superseded", "AbortError"))
  const waiting = reservationWaiters.findIndex((item) => item.key === input.key)
  if (waiting >= 0) {
    const [previous] = reservationWaiters.splice(waiting, 1)
    if (previous) {
      waitingBytes -= previous.bytes
      previous.reject(new DOMException("Markdown frame reservation was superseded", "AbortError"))
    }
  }
  if (!input.current()) return Promise.reject(new DOMException("Markdown frame reservation is stale", "AbortError"))
  if (fits(input.bytes)) return Promise.resolve(makeReservation(input.key, input.bytes))
  if (
    reservationWaiters.length >= MARKDOWN_FRAME_WORK_MAX_WAITERS ||
    waitingBytes + input.bytes > MARKDOWN_FRAME_WORK_MAX_WAITING_BYTES
  )
    return Promise.reject(new Error("Markdown frame reservation demand is full"))
  return new Promise<MarkdownFrameWorkReservation>((resolve, reject) => {
    reservationWaiters.push({ ...input, resolve, reject })
    waitingBytes += input.bytes
  })
}

export function releaseMarkdownFrameWorkReservation(reservation: MarkdownFrameWorkReservation) {
  releaseReservation(reservation)
}

function schedule() {
  if (scheduled || byKey.size === 0 || document.hidden) return
  scheduled = true
  const run = () => {
    scheduled = false
    flush()
  }
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run)
  else setTimeout(run, 16)
}

function choose() {
  const bg = queues.background[0]
  if (bg && frame - bg.age >= 120) {
    activePriorityStreak = 0
    return queues.background.shift()
  }
  const visible = queues.visible
  const tail = queues.tail
  if (visible.length && (activePriorityStreak >= 4 || tail.length === 0)) {
    activePriorityStreak = 0
    return visible.shift()
  }
  if (tail.length) {
    activePriorityStreak++
    return tail.shift()
  }
  if (visible.length) {
    activePriorityStreak = 0
    return visible.shift()
  }
  activePriorityStreak = 0
  return queues.background.shift()
}

function flush() {
  if (document.hidden) return
  frame++
  // Main-thread rich sanitization is deliberately serialized: each job is
  // input-capped and only one runs between paint opportunities.
  const work = choose()
  if (!work) return
  byKey.delete(work.key)
  bytes -= work.bytes
  if (!work.current()) {
    work.reject(new DOMException("Markdown frame work was superseded", "AbortError"))
  } else {
    try {
      work.resolve(work.run())
      completed++
    } catch (error) {
      work.reject(error instanceof Error ? error : new Error(String(error)))
    }
  }
  promoteReservations()
  schedule()
}

/** Run one bounded main-thread Markdown task in the shared frame owner. */
export function runMarkdownFrameWork<T>(input: {
  key: string
  priority: MarkdownWorkPriority
  bytes: number
  current: () => boolean
  run: () => T
}, reservation?: MarkdownFrameWorkReservation) {
  if (input.bytes > MARKDOWN_FRAME_WORK_MAX_JOB_BYTES)
    return Promise.reject<T>(new Error("Markdown frame task exceeded its per-job byte bound"))
  const existing = byKey.get(input.key)
  if (existing) remove(existing, new DOMException("Markdown frame work was superseded", "AbortError"))
  const held = reservation && reservations.get(input.key) === reservation
  if (reservation && !held)
    return Promise.reject<T>(new DOMException("Markdown frame reservation is no longer active", "AbortError"))
  if (reservation && input.bytes > reservation.bytes)
    return Promise.reject<T>(new Error("Markdown frame task exceeded its reserved byte bound"))
  if (byKey.size >= MARKDOWN_FRAME_WORK_MAX_JOBS || bytes + input.bytes > MARKDOWN_FRAME_WORK_MAX_BYTES)
    if (!reservation) return Promise.reject<T>(new Error("Markdown frame queue is full"))
  return new Promise<T>((resolve, reject) => {
    if (reservation) {
      reservations.delete(input.key)
      reservedBytes -= reservation.bytes
    }
    const charge = reservation?.bytes ?? input.bytes
    const work: Work<T> = { ...input, bytes: charge, order: order++, age: frame, resolve, reject }
    byKey.set(input.key, work as Work<unknown>)
    queues[input.priority].push(work as Work<unknown>)
    bytes += charge
    schedule()
  })
}

/** Cancel queued parse/sanitize continuations owned by a Markdown root. */
export function cancelMarkdownFrameWork(owner: string) {
  for (const work of [...byKey.values()]) {
    if (work.key === owner || work.key.startsWith(`${owner}:`))
      remove(work, new DOMException("Markdown owner was hidden or disposed", "AbortError"))
  }
  for (const [key, reservation] of reservations) {
    if (key === owner || key.startsWith(`${owner}:`)) releaseReservation(reservation)
  }
  for (let index = reservationWaiters.length - 1; index >= 0; index--) {
    const waiter = reservationWaiters[index]!
    if (waiter.key !== owner && !waiter.key.startsWith(`${owner}:`)) continue
    reservationWaiters.splice(index, 1)
    waitingBytes -= waiter.bytes
    waiter.reject(new DOMException("Markdown owner was hidden or disposed", "AbortError"))
  }
}

export function resumeMarkdownFrameWork() {
  if (!document.hidden) schedule()
}

export function markdownFrameWorkSnapshot() {
  return {
    queuedJobs: byKey.size,
    queuedBytes: bytes,
    reservedJobs: reservations.size,
    reservedBytes,
    waitingDemand: reservationWaiters.length,
    waitingDemandBytes: waitingBytes,
    completed,
    frame,
  }
}
