import path from "node:path"
import { Effect } from "effect"
import type { Matcher } from "./matcher"
import {
  basenameContainsQuerySubsequence,
  omittedSingleTokenScoreUpperBound,
  searchFileMentionsFast,
} from "./mention-fast"

/**
 * Instance-qualified pipe for the isolated OpenFork development target.
 *
 * Overridable so the transport lifecycle (timeout, reconnect, restart, invalid
 * handle, shutdown ordering) can be driven against a local fixture pipe without
 * a live Everything index. Production uses the default and never spawns a
 * helper executable: there is no es.exe or native-helper dependency anywhere
 * in this module.
 */
const PIPE = process.env.OPENFORK_EVERYTHING_SDK3_PIPE ?? "\\\\.\\pipe\\Everything IPC (OpenFork-SDK3)"
const SEARCH = 7
const IS_DB_LOADED = 8
const RESPONSE_MORE = 100
const RESPONSE_OK = 200
const MATCH_PATH = 0x00000004
const FLAG_64BIT = 0x00004000
const PROPERTY_PATH_AND_NAME = 240
const PATH_TYPES = new Set([8, 9, 10, 14, 15])
const ITEM_FOLDER = 0x01
const MAX_FRAME = 16 * 1024 * 1024
const MAX_RESPONSE = 64 * 1024 * 1024
const MAX_VIEWPORT = 10_000
const TIMEOUT_MS = 1500
/**
 * Hard allocation bounds.
 *
 * An SDK3 body is a length-prefixed stream, so every count on the wire is
 * corruption- or hostile-controlled until it is checked. Each bound below is
 * enforced BEFORE any allocation, so a corrupt header cannot make this process
 * allocate memory proportional to a number it just read off the pipe.
 *
 * Evidence (diagnostic capture, diagnostic-only, no production dependency:
 * packages/core/script/everything-bench/sdk3-wire-audit.ts against a live
 * Everything 1.5.0.1423b on \\.\pipe\Everything IPC (OpenFork-SDK3)):
 *   - observed body cap 65528 bytes per frame (a 1000-item viewport -> 3 frames)
 *   - observed sorts == 1 and props == 1
 *   - observed a 3053-item viewport (478750 bytes across 8 frames)
 */
const MAX_ITEMS = MAX_VIEWPORT
const MAX_SORTS = 16
const MAX_REQUEST = 64 * 1024
/**
 * Readiness is a FRESHNESS claim about the provider's in-memory index, not a
 * liveness claim about the pipe. Everything can begin reloading its database
 * on a socket that never closes, so an unbounded "already ready" cache would
 * keep reporting a stale index as fresh indefinitely. Re-ask after this TTL
 * rather than trusting an arbitrarily old answer.
 */
const READY_TTL_MS = 5_000

/**
 * Transport/protocol bounds, exported so the decoder gates can be asserted
 * directly by tests instead of being re-stated as magic numbers.
 */
export const SDK3_LIMITS = {
  MAX_FRAME,
  MAX_RESPONSE,
  MAX_VIEWPORT,
  MAX_ITEMS,
  MAX_SORTS,
  MAX_REQUEST,
  READY_TTL_MS,
  TIMEOUT_MS,
} as const

class BusyError extends Error {
  constructor() {
    super("SDK3 client busy")
  }
}

function vlq(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid VLQ")
  if (value < 0xff) return Buffer.from([value])
  let next = value - 0xff
  if (next < 0xffff) { const out = Buffer.allocUnsafe(3); out[0] = 0xff; out.writeUInt16LE(next, 1); return out }
  next -= 0xffff
  if (next < 0xffffffff) { const out = Buffer.allocUnsafe(7); out[0] = 0xff; out.writeUInt16LE(0xffff, 1); out.writeUInt32LE(next, 3); return out }
  throw new RangeError("VLQ too large")
}

function readVlq(buffer: Buffer, cursor: { offset: number }) {
  if (cursor.offset >= buffer.length) throw new Error("truncated VLQ")
  const byte = buffer[cursor.offset++]!
  if (byte < 0xff) return byte
  if (cursor.offset + 2 > buffer.length) throw new Error("truncated VLQ")
  const word = buffer.readUInt16LE(cursor.offset); cursor.offset += 2
  if (word < 0xffff) return 0xff + word
  if (cursor.offset + 4 > buffer.length) throw new Error("truncated VLQ")
  const dword = buffer.readUInt32LE(cursor.offset); cursor.offset += 4
  if (dword < 0xffffffff) return 0xff + 0xffff + dword
  throw new Error("unsupported oversized VLQ")
}

function readSize(buffer: Buffer, cursor: { offset: number }, wide: boolean) {
  if (!wide) { if (cursor.offset + 4 > buffer.length) throw new Error("truncated SIZE_T"); const v = buffer.readUInt32LE(cursor.offset); cursor.offset += 4; return v }
  if (cursor.offset + 8 > buffer.length) throw new Error("truncated SIZE_T")
  const v = buffer.readBigUInt64LE(cursor.offset); cursor.offset += 8
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("SIZE_T too large")
  return Number(v)
}

function encodeCompiled(root: string, compiledQuery: string, count: number) {
  const text = `ancestor:"${root.replaceAll('"', '""')}" ${compiledQuery}`.trim()
  const q = Buffer.from(text, "utf8")
  const flags = Buffer.allocUnsafe(4); flags.writeUInt32LE(FLAG_64BIT | MATCH_PATH)
  const viewport = Buffer.allocUnsafe(16); viewport.writeBigUInt64LE(0n, 0); viewport.writeBigUInt64LE(BigInt(count), 8)
  const prop = Buffer.allocUnsafe(8); prop.writeUInt32LE(PROPERTY_PATH_AND_NAME, 0); prop.writeUInt32LE(0, 4)
  return Buffer.concat([flags, vlq(q.length), q, viewport, vlq(0), vlq(1), prop])
}

function compileCandidateQuery(query: string) {
  const raw = query.trim().slice(0, 64)
  if (!raw) return ""
  const directoryMode = /[\\/]$/.test(raw)
  const normalized = raw.toLowerCase().replaceAll("\\", "/").replace(/[.*?"<>|()[\]{}!^$+]/g, " ")
  const tokens = normalized.split(/[\s/_-]+/).filter(Boolean)
  if (tokens.length === 0) return ""
  const quoted = tokens.map((token) => `*${token.replaceAll('"', '""')}*`)
  if (directoryMode) return `folder: ${quoted.join(" ")}`
  return quoted.join(" ")
}

function compileExpandedCandidateQuery(query: string) {
  const raw = query.trim().slice(0, 64)
  if (!raw || /\s/.test(raw) || /[\\/]$/.test(raw)) return
  const token = raw.toLowerCase().replace(/[^a-z0-9]/g, "")
  if (token.length < 2 || token.length > 8) return
  // Exhaustive basename subsequence coverage is stronger than the earlier
  // boundary-only acronym supplement: any native match omitted from this
  // source must consume at least one character from a directory segment.
  // mention-fast can therefore place a strict upper bound on every omitted
  // score and certify top-K when the returned floor dominates that bound.
  const pattern = token.split("").join(".*?")
  return `case:regex:name:"(?i:${pattern})"`
}


/**
 * Decode exactly one complete SDK3 SEARCH response body.
 *
 * Wire layout, confirmed byte-exactly against a live instance rather than
 * assumed:
 *   u32 flags | SIZE_T folders | SIZE_T files | SIZE_T viewportOffset |
 *   SIZE_T viewportCount | VLQ sorts (+ 8 bytes/sort) | VLQ props |
 *   9-byte property descriptor | items[]
 * SIZE_T is u64 when flags & FLAG_64BIT (observed flags = 0x4004).
 *
 * A multi-frame response is ONE CONTINUOUS item stream with NO repeated
 * header. Verified by requesting a 1000-item viewport and observing three
 * frames (65528/65528/2937) whose second frame begins directly with item path
 * bytes, so a per-frame header parse yields garbage. Callers must concatenate
 * RESPONSE_MORE bodies and call this exactly once per response.
 */
export function parse(buffer: Buffer) {
  const c = { offset: 0 }
  if (buffer.length < 4) throw new Error("truncated response")
  const flags = buffer.readUInt32LE(c.offset); c.offset += 4
  const wide = Boolean(flags & FLAG_64BIT)
  const folders = readSize(buffer, c, wide)
  const files = readSize(buffer, c, wide)
  const viewportOffset = readSize(buffer, c, wide)
  const viewportCount = readSize(buffer, c, wide)
  if (folders + files > Number.MAX_SAFE_INTEGER) throw new Error("SDK3 total overflows")
  const sorts = readVlq(buffer, c)
  // Bound the sort block BEFORE consuming it. `sorts * 8` is wire-controlled and
  // is used to advance the cursor, so unchecked it jumps far past the buffer and
  // the real fault surfaces later as a misleading "truncated VLQ".
  if (sorts > MAX_SORTS) throw new Error("SDK3 sort count exceeds bound")
  const sortBytes = sorts * 8
  if (c.offset + sortBytes > buffer.length) throw new Error("truncated sort block")
  c.offset += sortBytes
  const props = readVlq(buffer, c)
  if (props !== 1 || c.offset + 9 > buffer.length) throw new Error("unexpected property schema")
  const id = buffer.readUInt32LE(c.offset); const propFlags = buffer.readUInt32LE(c.offset + 4); const type = buffer[c.offset + 8]!; c.offset += 9
  if (id !== PROPERTY_PATH_AND_NAME || propFlags !== 0 || !PATH_TYPES.has(type)) throw new Error("unexpected path property")
  // ALLOCATION BOUND. viewportCount is a SIZE_T read off the wire and must be
  // rejected before the loop can allocate one object per iteration.
  if (viewportCount > MAX_ITEMS) throw new Error("SDK3 viewport exceeds item bound")
  // This provider only ever requests offset 0. A nonzero offset means the rows
  // are not the head of the result set, so every downstream completeness claim
  // (`items.length >= total` -> the omitted set is empty) would be false while
  // still reading as success. Fail closed instead of silently truncating.
  if (viewportOffset !== 0) throw new Error("unexpected SDK3 viewport offset")
  // Tighter bound, and the one that makes the loop provably O(buffer): every
  // item costs at least 2 bytes (1 flag byte + 1 VLQ length byte).
  if (viewportCount * 2 > buffer.length - c.offset) throw new Error("truncated item")
  const items: Array<{ fullPath: string; isDir: boolean }> = []
  for (let i = 0; i < viewportCount; i++) {
    if (c.offset >= buffer.length) throw new Error("truncated item")
    const itemFlags = buffer[c.offset++]!
    const len = readVlq(buffer, c)
    if (c.offset + len > buffer.length) throw new Error("truncated path")
    items.push({ fullPath: buffer.toString("utf8", c.offset, c.offset + len), isDir: Boolean(itemFlags & ITEM_FOLDER) })
    c.offset += len
  }

  if (c.offset !== buffer.length) throw new Error("trailing SDK3 bytes")
  return { total: files + folders, viewportOffset, items }
}

/**
 * Minimal socket surface used by the transport. `net.Socket` satisfies it, and
 * so does a `node:stream` Duplex, which is what lets the framing / timeout /
 * restart / shutdown lifecycle be exercised offline and identically under both
 * Node and Bun (named pipes only exist on win32, so a win32-only transport test
 * would NOT be a parity gate).
 */
export interface Sdk3SocketLike {
  destroyed: boolean
  write(data: Buffer, callback?: (error?: Error | null) => void): boolean
  destroy(): void
  on(event: string, listener: (...args: never[]) => void): unknown
  once(event: string, listener: (...args: never[]) => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
}

export interface ClientOptions {
  readonly pipe?: string
  readonly timeoutMs?: number
  readonly createSocket?: () => Sdk3SocketLike
}

export class Client {
  private socket?: import("node:net").Socket
  /**
   * Reassembly queue. The previous implementation did
   * `rx = Buffer.concat([rx, chunk])` per socket read, which is O(n^2): a
   * 64 MiB MAX_RESPONSE arriving in 64 KiB frames copies ~34 GiB. This keeps the
   * received bytes as a queue and materializes only the prefix a frame header
   * or frame body actually needs, making reassembly O(n).
   */
  private rxChunks: Buffer[] = []
  private rxBytes = 0
  private busy = false
  private readyKnown = false
  /** Epoch ms of the last confirmed DB_LOADED, for the freshness TTL. */
  private readyAt = 0
  /** Monotonic request counter, used to prove response/request correlation. */
  private requestSeq = 0
  private pending?: {
    readonly resolve: (value: Buffer) => void
    readonly reject: (error: unknown) => void
    readonly chunks: Buffer[]
    bytes: number
    readonly socket: import("node:net").Socket
    readonly id: number
    readonly timer: ReturnType<typeof setTimeout>
  }

  private readonly pipe: string
  private readonly timeoutMs: number

  constructor(private readonly options: ClientOptions = {}) {
    this.pipe = options.pipe ?? PIPE
    this.timeoutMs = options.timeoutMs ?? TIMEOUT_MS
  }


  private async connect() {
    if (this.socket && !this.socket.destroyed) return this.socket
    const { default: net } = await import("node:net")
    return await new Promise<import("node:net").Socket>((resolve, reject) => {
      const socket = (this.options.createSocket
        ? this.options.createSocket()
        : net.createConnection(this.pipe)) as import("node:net").Socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error("SDK3 connect timeout"))
      }, this.timeoutMs)
      const fail = (error: unknown) => {
        clearTimeout(timer)
        socket.destroy()
        reject(error)
      }
      socket.once("error", fail)
      socket.once("connect", () => {
        clearTimeout(timer)
        socket.off("error", fail)
        socket.on("error", (error) => {
          if (this.socket === socket) this.fail(error)
        })
        socket.on("close", () => {
          if (this.socket === socket) this.fail(new Error("SDK3 pipe closed"))
        })
        socket.on("data", (chunk) => {
          if (this.socket === socket) this.onData(chunk)
        })
        this.socket = socket
        this.readyKnown = false
        this.readyAt = 0
        resolve(socket)
      })
    })
  }

  private fail(error: unknown) {
    this.busy = false
    this.readyKnown = false
    this.readyAt = 0
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    const socket = this.socket
    this.socket = undefined
    if (socket && !socket.destroyed) socket.destroy()
    this.rxChunks = []
    this.rxBytes = 0
  }

  /**
   * Return a contiguous prefix of at least `want` bytes, or undefined when not
 * enough bytes have arrived. Merges only as many leading chunks as the prefix
 * needs; every merged chunk is consumed, so total copying stays linear.
 */
  private rxPrefix(want: number) {
    if (want <= 0) return this.rxChunks[0]
    if (this.rxBytes < want) return undefined
    const first = this.rxChunks[0]
    if (!first) return undefined
    if (first.length >= want) return first
    let merged = first
    let index = 1
    while (merged.length < want && index < this.rxChunks.length) {
      const next = this.rxChunks[index]!
      merged = Buffer.concat([merged, next], merged.length + next.length)
      index++
    }
    this.rxChunks[0] = merged
    this.rxChunks.splice(1, index - 1)
    // Fail closed on our own terms. A short merge means the accounting and the
    // queue disagree; returning a truncated prefix would let a caller decode a
    // frame out of a partial buffer instead of treating it as not-yet-arrived.
    if (merged.length < want) return undefined
    return merged
  }

  /** Consume the first `count` buffered bytes. */
  private rxDrop(count: number) {
    // The byte counter MUST move with the chunk list, or a later rxPrefix()
    // believes bytes are buffered when the queue is empty.
    const drop = Math.min(count, this.rxBytes)
    this.rxBytes -= drop
    let remaining = drop
    while (remaining > 0) {
      const first = this.rxChunks[0]
      if (!first) return
      if (first.length > remaining) {
        this.rxChunks[0] = first.subarray(remaining)
        return
      }
      remaining -= first.length
      this.rxChunks.shift()
    }
  }

  private onData(chunk: Buffer) {
    this.rxChunks.push(chunk)
    this.rxBytes += chunk.length
    for (;;) {
      const header = this.rxPrefix(8)
      if (!header) return
      const code = header.readUInt32LE(0)
      const size = header.readUInt32LE(4)
      if (size > MAX_FRAME) return this.fail(new Error("SDK3 frame too large"))
      // Bound the frame BEFORE buffering its bytes, so an oversized frame is
      // rejected on its declared length rather than after it has been received.
      if (this.rxBytes < 8 + size) return
      const frame = this.rxPrefix(8 + size)
      // The counter said enough bytes are buffered but the queue could not
      // produce them. That is an accounting fault, not a partial read, so fail
      // closed instead of decoding from a truncated prefix.
      if (!frame) return this.fail(new Error("SDK3 reassembly desynchronized"))
      const body = frame.subarray(8, 8 + size)
      this.rxDrop(8 + size)
      const pending = this.pending
      if (!pending) return this.fail(new Error("unexpected SDK3 response"))
      // Correlation guard. SDK3 is strictly serialized over one pipe, so a
      // frame that is not addressed to the socket the current request was
      // written on is a cross-wired or resurrected request, never a valid
      // response. Treat it as transport failure rather than decoding it.
      if (pending.socket !== this.socket) return this.fail(new Error("SDK3 response socket mismatch"))
      if (code !== RESPONSE_MORE && code !== RESPONSE_OK) {
        this.pending = undefined
        clearTimeout(pending.timer)
        pending.reject(new Error(`SDK3 response ${code}`))
        continue
      }
      pending.chunks.push(body)
      pending.bytes += body.length
      if (pending.bytes > MAX_RESPONSE) return this.fail(new Error("SDK3 response too large"))
      if (code !== RESPONSE_OK) continue
      this.pending = undefined
      clearTimeout(pending.timer)
      pending.resolve(Buffer.concat(pending.chunks, pending.bytes))
    }
  }

  /**
   * Release the pipe and reject any in-flight request.
   *
   * The module singletons previously had no shutdown path at all, so a socket
   * stayed open for the process lifetime and an in-flight request could not be
   * cancelled deterministically. Startup order is unchanged (the Client
   * constructor is inert); shutdown now has an explicit, idempotent owner.
   */
  dispose(reason = "SDK3 provider disposed") {
    this.busy = false
    this.readyKnown = false
    this.readyAt = 0
    const pending = this.pending
    this.pending = undefined
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error(reason))
    }
    const socket = this.socket
    this.socket = undefined
    if (socket && !socket.destroyed) socket.destroy()
    this.rxChunks = []
    this.rxBytes = 0
  }

  private async searchCompiled(root: string, compiledQuery: string, count: number, isStale?: () => boolean) {
    // PIPE-WAIT leak point: a superseded generation must not occupy the shared
    // pipe. Owned by keystream-lifecycle as an additive guard; transport
    // semantics (framing/VLQ/paging) are untouched and ipc-runtime remains owner.
    throwIfStale(isStale, "pipe-wait")
    if (this.busy) throw new BusyError()
    this.busy = true
    try {
      const socket = await this.connect()
      throwIfStale(isStale, "pipe-wait")
      const payload = encodeCompiled(root, compiledQuery, count)
      return await new Promise<ReturnType<typeof parse>>((resolve, reject) => {
      const header = Buffer.allocUnsafe(8)
      header.writeUInt32LE(SEARCH, 0)
      header.writeUInt32LE(payload.length, 4)
      const timer = setTimeout(() => {
        if (!this.pending) return
        this.pending = undefined
        this.busy = false
        this.readyKnown = false
        this.readyAt = 0
        this.rxChunks = []
        this.rxBytes = 0
        const active = this.socket
        this.socket = undefined
        if (active && !active.destroyed) active.destroy()
        reject(new Error("SDK3 timeout"))
      }, this.timeoutMs)
      this.pending = {
        chunks: [],
        bytes: 0,
        socket,
        id: ++this.requestSeq,
        timer,
        resolve: (buffer) => {
          this.busy = false
          try {
            // DECODE leak point: drop a superseded frame before UTF-8 path
            // extraction. The pending bytes are already paid (wasted IPC) but
            // no rows leak into fence/rerank/proof.
            if (isStale?.()) {
              reject(new StaleError("decode"))
              return
            }
            resolve(parse(buffer))
          } catch (error) {
            reject(error)
          }
        },
        reject: (error) => {
          this.busy = false
          reject(error)
        },
      }
      socket.write(Buffer.concat([header, payload]), (error) => {
        if (error) this.fail(error)
      })
      })
    } catch (error) {
      this.busy = false
      throw error
    }
  }

  async search(root: string, text: string, count: number, isStale?: () => boolean) {
    // PAGING leak point: exact + broad are sequential round trips. A keystroke
    // arriving between them must cancel the second trip rather than paying
    // both and merging stale rows at publication.
    throwIfStale(isStale, "paging")
    const exactQuery = compileCandidateQuery(text)
    const exact = await this.searchCompiled(root, exactQuery, count, isStale)
    throwIfStale(isStale, "paging")
    const expanded = compileExpandedCandidateQuery(text)
    const broad = expanded ? await this.searchCompiled(root, expanded, count, isStale) : undefined
    throwIfStale(isStale, "paging")
    if (!broad) {
      const totalUpperBound = exact.total
      return {
        ...exact,
        basenameSubsequenceComplete: false,
        complete: exact.items.length >= exact.total,
        requiredCount: Math.min(MAX_VIEWPORT, exact.total),
        exhaustible: totalUpperBound <= MAX_VIEWPORT,
      }
    }
    const seen = new Set<string>()
    // The basename-subsequence branch is the certifying coverage source. Keep
    // every exhaustive broad row ahead of opportunistic exact-path rows so a
    // large exact source cannot push proven basename coverage past the viewport.
    const union = [...broad.items, ...exact.items].filter((item) => {
      const key = item.fullPath.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const complete =
      exact.items.length >= exact.total &&
      broad.items.length >= broad.total &&
      union.length <= count
    // DRAINABILITY IS PER-SOURCE, NOT A SUM.
    //
    // Each source is its own SEARCH request carrying its own viewport
    // (encodeCompiled writes viewport = (offset 0, count)), and the server
    // answers `min(count, thatSource.total)` -- measured on the live instance:
    // count=1000 against a 3053-total root returned viewportCount=1000, while
    // count=5000 returned 3053. The viewport is therefore a PER-SOURCE budget,
    // not a shared one, so draining both sources requires count >=
    // max(exact.total, broad.total).
    //
    // The previous `exact.total + broad.total` summed two heavily-overlapping
    // enumerations of the SAME root (the `seen` Set above is the code admitting
    // the overlap), so it double-counted and was not a conservative estimate of
    // the union -- it was actively wrong in both directions: `exhaustible`
    // falsely denied drainability, and `requiredCount` over-provisioned every
    // source past what it needed. On an 8,190-path root that cross the 10k cap
    // on double-count alone and truncated a source that fit.
    //
    // Note `total` below already used Math.max, so the object previously
    // contradicted itself.
    const perSourceTotal = Math.max(exact.total, broad.total)
    return {
      total: perSourceTotal,
      viewportOffset: 0,
      items: union.slice(0, count),
      basenameSubsequenceComplete: broad.items.length >= broad.total,
      complete,
      requiredCount: Math.min(MAX_VIEWPORT, perSourceTotal),
      exhaustible: perSourceTotal <= MAX_VIEWPORT,
    }
  }

  async ready(isStale?: () => boolean) {
    throwIfStale(isStale, "pipe-wait")
    // Freshness gate. `readyKnown` alone would report a stale index as fresh
    // forever, because a provider can reload its database underneath a socket
    // that never closes. Anything older than the TTL is re-asked rather than
    // trusted.
    if (
      this.readyKnown &&
      this.socket &&
      !this.socket.destroyed &&
      Date.now() - this.readyAt < READY_TTL_MS
    ) return true
    if (this.busy) throw new BusyError()
    this.busy = true
    try {
      const socket = await this.connect()
      const header = Buffer.allocUnsafe(8)
      header.writeUInt32LE(IS_DB_LOADED, 0)
      header.writeUInt32LE(0, 4)
      const response = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!this.pending) return
          this.pending = undefined
          this.busy = false
          // The readiness timeout previously left `readyKnown` untouched while
          // `searchCompiled`'s timeout cleared it. Inconsistent invalidation
          // meant a readiness failure could leave a stale "ready" answer live.
          this.readyKnown = false
          this.readyAt = 0
          this.rxChunks = []
          this.rxBytes = 0
          const active = this.socket
          this.socket = undefined
          if (active && !active.destroyed) active.destroy()
          reject(new Error("SDK3 readiness timeout"))
        }, this.timeoutMs)
        this.pending = {
          chunks: [],
          bytes: 0,
          socket,
          id: ++this.requestSeq,
          timer,
          resolve: (buffer) => {
            this.busy = false
            resolve(buffer)
          },
          reject: (error) => {
            this.busy = false
            reject(error)
          },
        }
        socket.write(header, (error) => {
          if (error) this.fail(error)
        })
      })
      const loaded = response.length === 4 && response.readUInt32LE(0) !== 0
      this.readyKnown = loaded
      this.readyAt = loaded ? Date.now() : 0
      return loaded
    } catch (error) {
      this.busy = false
      this.readyKnown = false
      this.readyAt = 0
      throw error
    }
  }
}

const foregroundClient = process.platform === "win32" ? new Client() : undefined
const shadowClient = process.platform === "win32" ? new Client() : undefined

/**
 * Release both module singleton pipes.
 *
 * Startup stays lazy and inert (constructing a Client opens nothing), and
 * shutdown is now explicit and idempotent: an in-flight SDK3 request is
 * rejected instead of hanging until its timeout, and the socket is closed
 * rather than being left for process teardown. Exported so shutdown ordering is
 * testable and callable by an owning lifecycle.
 */
export function shutdownEverythingProvider(reason = "SDK3 provider shut down") {
  foregroundClient?.dispose(reason)
  shadowClient?.dispose(reason)
}

export function normalizeCandidate(root: string, item: { fullPath: string; isDir: boolean }): Matcher.PathEntry | undefined {
  if (!path.isAbsolute(item.fullPath)) return
  const canonical = path.resolve(root)
  const absolute = path.resolve(item.fullPath)
  const fold = (value: string) => process.platform === "win32" ? value.toLowerCase() : value
  const rootFold = fold(canonical), absFold = fold(absolute)
  const prefix = rootFold.endsWith(path.sep) ? rootFold : rootFold + path.sep
  if (absFold !== rootFold && !absFold.startsWith(prefix)) return
  const relative = path.relative(canonical, absolute).replaceAll("\\", "/")
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) return
  if (relative.split("/").some((segment) => segment === "" || segment.startsWith("."))) return
  return { path: relative, isDir: item.isDir }
}

type CandidateSearch =
  | {
      readonly status: "measured"
      readonly paths: readonly Matcher.PathEntry[]
      /**
       * Rows the provider enumerated but `normalizeCandidate`/`ignore`
       * discarded. These are UNBOUNDED members of the native corpus's omitted
       * set: they were never scored, so the omitted-score upper bound does not
       * cover them. Anything certifying top-K must consult this list.
       */
      readonly discardedPaths: readonly string[]
      readonly basenameSubsequenceComplete: boolean
      readonly complete: boolean
      readonly requiredCount: number
      readonly exhaustible: boolean
    }
  | {
      readonly status: "busy"
      readonly paths: readonly []
      readonly complete: false
      readonly requiredCount: 0
      readonly exhaustible: false
    }
  | {
      readonly status: "unavailable"
      readonly reason: "unsupported" | "database-loading" | "transport" | "protocol"
      readonly detail?: string
      readonly paths: readonly []
      readonly complete: false
      readonly requiredCount: 0
      readonly exhaustible: false
    }

function unavailableCandidate(
  reason: Extract<CandidateSearch, { status: "unavailable" }>["reason"],
  detail?: string,
): CandidateSearch {
  return {
    status: "unavailable",
    reason,
    detail,
    paths: [],
    complete: false,
    requiredCount: 0,
    exhaustible: false,
  }
}

function searchCandidatesDetailed(
  input: { root: string; query: string; count: number; ignore?: (relative: string) => boolean },
  client: Client | undefined = foregroundClient,
  isStale?: () => boolean,
) {
  if (!client) {
    return Effect.succeed<CandidateSearch>(unavailableCandidate("unsupported"))
  }
  return Effect.promise(async () => {
    try {
      throwIfStale(isStale, "pipe-wait")
      if (!(await client.ready(isStale))) {
        return unavailableCandidate("database-loading")
      }
      throwIfStale(isStale, "paging")
      const result = await client.search(input.root, input.query, Math.min(MAX_VIEWPORT, Math.max(1, input.count)), isStale)
      throwIfStale(isStale, "decode")
      // Identical selection semantics to the previous flatMap - same call
      // order, same normalization, same ignore consultation, same output order
      // - but the rejected rows are retained so proof can see them.
      const paths: Matcher.PathEntry[] = []
      const discardedPaths: string[] = []
      let fenced = 0
      for (const item of result.items) {
        // FENCE leak point: root/escape/dot-segment + ignore rows must never
        // reach rerank. Check per item (one boolean call) so a 10k page aborts
        // mid-fence instead of scoring 10k stale rows.
        if ((fenced++ & 31) === 0) throwIfStale(isStale, "fence")
        const candidate = normalizeCandidate(input.root, item)
        if (!candidate) {
          discardedPaths.push(item.fullPath)
          continue
        }
        if (input.ignore?.(candidate.path)) {
          discardedPaths.push(item.fullPath)
          continue
        }
        paths.push(candidate)
      }
      return {
        status: "measured",
        paths,
        discardedPaths,
        basenameSubsequenceComplete: result.basenameSubsequenceComplete,
        complete: result.complete,
        requiredCount: result.requiredCount,
        exhaustible: result.exhaustible,
      } as CandidateSearch
    } catch (error) {
      // Stale is scheduler ownership, never a transport/protocol failure.
      // Re-throw so runShadow maps it to a zero-coverage stale skip.
      if (error instanceof StaleError) throw error
      if (error instanceof BusyError) {
        return { status: "busy", paths: [], complete: false, requiredCount: 0, exhaustible: false } as CandidateSearch
      }
      const detail = error instanceof Error ? error.message : String(error)
      const protocol =
        /truncated|unexpected SDK3|property schema|path property|SIZE_T|VLQ|frame too large|response too large/.test(detail)
      return unavailableCandidate(protocol ? "protocol" : "transport", detail)
    }
  })
}

export function searchCandidatePage(input: { root: string; query: string; count: number; ignore?: (relative: string) => boolean }) {
  return searchCandidatesDetailed(input)
}

function searchCandidatesExhaustiveDetailed(
  input: {
    root: string
    query: string
    initialCount: number
    ignore?: (relative: string) => boolean
  },
  client: Client | undefined = foregroundClient,
  isStale?: () => boolean,
) {
  return Effect.gen(function* () {
    const first = yield* searchCandidatesDetailed(
      {
        root: input.root,
        query: input.query,
        count: input.initialCount,
        ignore: input.ignore,
      },
      client,
      isStale,
    )
    if (first.status !== "measured" || first.complete || !first.exhaustible) return first
    if (first.requiredCount <= input.initialCount) return first
    // PAGING leak point (viewport escalation): the retry doubles IPC. A newer
    // keystroke before the retry must skip it entirely.
    throwIfStale(isStale, "paging")
    const retry = yield* searchCandidatesDetailed(
      {
        root: input.root,
        query: input.query,
        count: first.requiredCount,
        ignore: input.ignore,
      },
      client,
      isStale,
    )
    if (retry.status !== "measured") return retry
    // A wider viewport is not guaranteed to re-enumerate the first attempt's
    // rows, so the retry cannot replace the first attempt's discard evidence.
    // Carry both, or the retry silently drops proof evidence collected moments
    // earlier and an uncertifiable row becomes certifiable.
    return { ...retry, discardedPaths: [...first.discardedPaths, ...retry.discardedPaths] }
  })
}

export function searchCandidatesExhaustive(input: {
  root: string
  query: string
  initialCount: number
  ignore?: (relative: string) => boolean
}) {
  return searchCandidatesExhaustiveDetailed(input)
}

/**
 * Path-only diagnostic convenience wrapper.
 *
 * User-visible planners must use searchCandidatePage/searchCandidatesExhaustive
 * so transport/protocol/unavailable states are never conflated with a genuine
 * zero-match result.
 */
export function searchCandidates(input: { root: string; query: string; count: number; ignore?: (relative: string) => boolean }) {
  return searchCandidatesDetailed(input).pipe(Effect.map((result) => result.paths))
}

export interface ShadowComparison {
  readonly measured: boolean
  readonly skippedReason?: "busy" | "unavailable" | "stale"
  readonly unavailableReason?: Extract<CandidateSearch, { status: "unavailable" }>["reason"]
  readonly detail?: string
  readonly complete: boolean
  readonly requiredCount: number
  readonly exhaustible: boolean
  readonly providerMs: number
  readonly candidateCount: number
  readonly nativeTopK?: number
  readonly coveredTopK?: number
  readonly recall?: number
  readonly missing: readonly string[]
  readonly orderedExact: boolean
  readonly proofFloor?: number
  readonly omittedScoreUpperBound?: number
  readonly provenTopK: boolean
  /** Measured-only: enumerated candidate rows rejected by normalization/ignore. */
  readonly discardedCount?: number
  /** Measured-only: every discarded row satisfies the bound's precondition. */
  readonly discardedCoverageSafe?: boolean
}

type ShadowInput = {
  root: string
  query: string
  count: number
  native: readonly Matcher.UnifiedResult[]
  corpus?: readonly Matcher.PathEntry[]
  limit?: number
  offset?: number
  ignore?: (relative: string) => boolean
}

type ShadowJob = {
  readonly generation: number
  readonly input: ShadowInput
  readonly resolve: (result: ShadowComparison) => void
}

/** Latest-generation ownership runs across eight observable stages. Every stage
 * boundary is a point where a superseded generation must be discarded before
 * its output can leak into a newer generation:
 *
 *   creation    compareShadow generation increment + single-pending coalescing.
 *                 Intermediate keystrokes resolve stale here with zero provider
 *                 work (see rapid-keystream test: s->se->sea->sear starts only
 *                 s + sear).
 *   pipe-wait   Client.connect + searchCompiled/ready pending slot + onData
 *                 chunk accumulation. A superseded job must stop waiting and
 *                 release the shared shadowClient so the newest job can use the
 *                 pipe (isStale check before/after connect, per-chunk budget).
 *   paging      Client.search exact+broad sequential round trips +
 *                 searchCandidatesExhaustiveDetailed first+retry viewport
 *                 escalation. Checks sit between exact/broad and before retry.
 *   decode      parse() of the reassembled frame. A superseded frame is dropped
 *                 before UTF-8 path extraction (check before parse).
 *   fence       normalizeCandidate root/escape/dot-segment rejection + ignore
 *                 consultation + discardedPaths accumulation. Checks per item
 *                 (cheap boolean) so a 10k-item page aborts mid-fence.
 *   rerank      measuredShadow corpus-order filter + searchFileMentionsFast
 *                 bounded top-K heap. Checks before/after the synchronous scan.
 *   proof       certifyCandidateTopK strict floor > bound + discardedCoverageSafe.
 *                 Check before certifying so stale CPU never mints proof fields.
 *   publication runShadow job.resolve + pending chain. Final generation guard:
 *                 job.generation !== shadowGeneration always resolves stale with
 *                 zero coverage (candidateCount 0, missing [], recall undefined)
 *                 so an older generation can NEVER merge into a newer one.
 */
export type ShadowStage =
  | "create"
  | "pipe-wait"
  | "paging"
  | "decode"
  | "fence"
  | "rerank"
  | "proof"
  | "publish"

export class StaleError extends Error {
  readonly stage: ShadowStage
  constructor(stage: ShadowStage) {
    super(`shadow superseded at ${stage}`)
    this.name = "StaleError"
    this.stage = stage
  }
}

function throwIfStale(isStale: (() => boolean) | undefined, stage: ShadowStage): void {
  if (isStale?.()) throw new StaleError(stage)
}

/** Provider result shape for the injected test executor. `discardedPaths` is
 * optional because offline fixtures only model enumerated candidates; the
 * scheduler defaults it to [] (a complete, auditable default, never undefined
 * downstream). */
export type ShadowProviderResult =
  | {
      readonly status: "measured"
      readonly paths: readonly Matcher.PathEntry[]
      readonly discardedPaths?: readonly string[]
      readonly basenameSubsequenceComplete: boolean
      readonly complete: boolean
      readonly requiredCount: number
      readonly exhaustible: boolean
    }
  | {
      readonly status: "busy"
      readonly paths: readonly []
      readonly complete: false
      readonly requiredCount: 0
      readonly exhaustible: false
    }
  | {
      readonly status: "unavailable"
      readonly reason: "unsupported" | "database-loading" | "transport" | "protocol"
      readonly detail?: string
      readonly paths: readonly []
      readonly complete: false
      readonly requiredCount: 0
      readonly exhaustible: false
    }

export type ShadowExecutorContext = {
  /** True when a newer generation has superseded this job. Cheap; call often. */
  readonly isStale: () => boolean
  /** Record reaching a stage (instrumentation) without throwing. */
  readonly stage: (stage: ShadowStage) => void
  /** Throw StaleError(stage) when superseded; no-op otherwise. */
  readonly check: (stage: ShadowStage) => void
}

export type ShadowExecutor = (
  input: { root: string; query: string; initialCount: number; ignore?: (relative: string) => boolean },
  ctx: ShadowExecutorContext,
) => Promise<ShadowProviderResult>

let shadowExecutorForTests: ShadowExecutor | undefined

/** Test-only provider injection. Offline by construction: lets the generation
 * suite drive every abort stage without a live Everything pipe. Reset with
 * `undefined` (the generation suite does so in afterAll so the fake never
 * leaks into other suites via the module singleton). */
export function setShadowExecutorForTests(executor: ShadowExecutor | undefined): void {
  shadowExecutorForTests = executor
}

export type ShadowStats = {
  readonly started: number
  readonly measured: number
  readonly stale: number
  readonly busy: number
  readonly unavailable: number
  /** How many jobs REACHED each stage (wasted-work numerator for superseded jobs). */
  readonly stageReached: Record<ShadowStage, number>
  /** How many jobs ABORTED at each stage via StaleError (saved-work proof). */
  readonly abortedByStage: Record<ShadowStage, number>
  /** Provider milliseconds spent on jobs that published stale (wasted IPC). */
  readonly wastedProviderMs: number
  /** Provider milliseconds spent on jobs that published measured. */
  readonly measuredProviderMs: number
}

const emptyStageRecord = (): Record<ShadowStage, number> => ({
  create: 0,
  "pipe-wait": 0,
  paging: 0,
  decode: 0,
  fence: 0,
  rerank: 0,
  proof: 0,
  publish: 0,
})

let shadowStats: {
  started: number
  measured: number
  stale: number
  busy: number
  unavailable: number
  stageReached: Record<ShadowStage, number>
  abortedByStage: Record<ShadowStage, number>
  wastedProviderMs: number
  measuredProviderMs: number
} = {
  started: 0,
  measured: 0,
  stale: 0,
  busy: 0,
  unavailable: 0,
  stageReached: emptyStageRecord(),
  abortedByStage: emptyStageRecord(),
  wastedProviderMs: 0,
  measuredProviderMs: 0,
}

/** Snapshot of scheduler instrumentation for tests and perf-freshness harnesses.
 * Stage timing beyond providerMs lives harness-side; these counters are the
 * stable contract: reached vs aborted per stage plus wasted vs measured ms. */
export function getShadowStats(): ShadowStats {
  return {
    started: shadowStats.started,
    measured: shadowStats.measured,
    stale: shadowStats.stale,
    busy: shadowStats.busy,
    unavailable: shadowStats.unavailable,
    stageReached: { ...shadowStats.stageReached },
    abortedByStage: { ...shadowStats.abortedByStage },
    wastedProviderMs: shadowStats.wastedProviderMs,
    measuredProviderMs: shadowStats.measuredProviderMs,
  }
}

/** Reset generation + scheduler + stats between isolated tests. Does NOT clear
 * the injected executor (tests own that via setShadowExecutorForTests). */
export function resetShadowSchedulerForTests(): void {
  shadowGeneration = 0
  shadowRunning = false
  shadowPending = undefined
  shadowStats = {
    started: 0,
    measured: 0,
    stale: 0,
    busy: 0,
    unavailable: 0,
    stageReached: emptyStageRecord(),
    abortedByStage: emptyStageRecord(),
    wastedProviderMs: 0,
    measuredProviderMs: 0,
  }
}

function recordStage(stage: ShadowStage): void {
  shadowStats.stageReached[stage]++
}

function recordAbort(stage: ShadowStage): void {
  shadowStats.abortedByStage[stage]++
}

let shadowGeneration = 0
let shadowRunning = false
let shadowPending: ShadowJob | undefined

function skippedShadow(
  reason: NonNullable<ShadowComparison["skippedReason"]>,
  providerMs = 0,
  unavailable?: Extract<CandidateSearch, { status: "unavailable" }>,
): ShadowComparison {
  return {
    measured: false,
    skippedReason: reason,
    unavailableReason: unavailable?.reason,
    detail: unavailable?.detail,
    complete: false,
    requiredCount: 0,
    exhaustible: false,
    providerMs,
    candidateCount: 0,
    missing: [],
    orderedExact: false,
    provenTopK: false,
  }
}

/**
 * Pure proof predicate for the optional candidate accelerator.
 *
 * Everything is candidate discovery only, so a certificate may only be issued
 * when the returned page is provably the canonical OpenFork page. Two things
 * must both hold, and both fail closed:
 *
 *   1. BOUNDED OMISSION. The omitted set is every native corpus row that never
 *      became a candidate. It splits into two disjoint populations:
 *        (1a) rows the certifying basename-subsequence source never enumerated;
 *        (1b) rows it enumerated but `normalizeCandidate`/`ignore` discarded.
 *      Population (1a) satisfies omittedSingleTokenScoreUpperBound's stated
 *      precondition, so the bound covers it. Population (1b) does NOT: a
 *      discarded row was never scored, so no bound applies to it and it may
 *      outrank the floor and corrupt the page while the certificate still
 *      passes. `discardedCoverageSafe` is therefore required, and it is checked
 *      per row rather than as "nothing was discarded at all" because real
 *      corpora discard the large majority of enumerated rows for root, hidden
 *      and ignore-policy reasons.
 *   2. A STRICT floor. `proofFloor` is only defined for a full page, so a short
 *      page can never certify. The comparison is strict: equality is reachable
 *      (query `ab` against `aB/x.ts` scores exactly the 34 * 2 bound) and an
 *      equal-scoring omitted row can still win the scorer's tie-break, so
 *      equality is UNPROVEN and never a pass.
 *
 * Pure and exported so the hostile proof cases can be driven offline, without a
 * live Everything index.
 */
export function certifyCandidateTopK(input: {
  readonly query: string
  readonly pageScores: readonly number[]
  readonly pageLimit: number
  readonly basenameSubsequenceComplete: boolean
  readonly discardedPaths: readonly string[]
}): {
  readonly proofFloor?: number
  readonly omittedScoreUpperBound?: number
  readonly discardedCoverageSafe: boolean
  readonly provenTopK: boolean
} {
  const omittedScoreUpperBound = omittedSingleTokenScoreUpperBound(
    input.query,
    "path-substring+basename-subsequence",
  )
  const proofFloor =
    input.pageScores.length === input.pageLimit ? input.pageScores[input.pageScores.length - 1] : undefined
  const discardedCoverageSafe = input.discardedPaths.every(
    (row) => !basenameContainsQuerySubsequence(input.query, row),
  )
  const provenTopK =
    input.basenameSubsequenceComplete &&
    proofFloor !== undefined &&
    omittedScoreUpperBound !== undefined &&
    proofFloor > omittedScoreUpperBound &&
    discardedCoverageSafe
  return { proofFloor, omittedScoreUpperBound, discardedCoverageSafe, provenTopK }
}

function measuredShadow(
  input: ShadowInput,
  candidateResult: Extract<CandidateSearch, { status: "measured" }>,
  providerMs: number,
  isStale?: () => boolean,
): ShadowComparison {
  // RERANK leak point: the bounded top-K heap is the hottest CPU in the shadow
  // lane. Check before the scan so superseded work never scores rows.
  throwIfStale(isStale, "rerank")
  const key = (value: string) => {
    const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "")
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
  }
  const candidatePaths = new Set(candidateResult.paths.map((entry) => key(entry.path)))
  const nativePaths = input.native
    .filter((entry) => entry.kind === "file")
    .map((entry) => entry.path)
    .filter((entry): entry is string => entry !== undefined)
    .map((entry) => entry.replaceAll("\\", "/").replace(/\/+$/, ""))
  const missing = nativePaths.filter((entry) => !candidatePaths.has(key(entry)))
  const nativeTopK = nativePaths.length
  const coveredTopK = nativeTopK - missing.length
  const limit = Math.max(1, input.limit ?? (input.native.length || 1))
  const offset = Math.max(0, input.offset ?? 0)
  // mention-fast uses corpus ID as its final deterministic tie-break. Reorder
  // discovered candidates by the authoritative native corpus before reranking
  // so Everything's own result order cannot perturb equal-score rows.
  const rerankPaths = input.corpus
    ? input.corpus.filter((entry) => candidatePaths.has(key(entry.path)))
    : candidateResult.paths
  const reranked = searchFileMentionsFast(rerankPaths, {
    query: input.query,
    limit,
    offset,
  })
  // PROOF leak point: certifying a superseded page would mint proofFloor /
  // provenTopK fields for a keystroke the user already abandoned. Check after
  // the scan and before certifying.
  throwIfStale(isStale, "proof")
  const lexical = (row: Matcher.UnifiedResult) => ({
    kind: row.kind,
    path: row.path,
    type: row.type,
    score: row.score,
    positions: row.positions,
    baseOffset: row.baseOffset,
  })
  const orderedExact =
    JSON.stringify(input.native.map(lexical)) === JSON.stringify(reranked.results.map(lexical))
  const proof = certifyCandidateTopK({
    query: input.query,
    pageScores: reranked.results.map((row) => row.score),
    pageLimit: limit,
    basenameSubsequenceComplete: candidateResult.basenameSubsequenceComplete,
    discardedPaths: candidateResult.discardedPaths,
  })
  return {
    measured: true,
    complete: candidateResult.complete,
    requiredCount: candidateResult.requiredCount,
    exhaustible: candidateResult.exhaustible,
    providerMs,
    candidateCount: candidateResult.paths.length,
    nativeTopK,
    coveredTopK,
    recall: nativeTopK === 0 ? 1 : coveredTopK / nativeTopK,
    missing,
orderedExact,
    proofFloor: proof.proofFloor,
    omittedScoreUpperBound: proof.omittedScoreUpperBound,
    provenTopK: proof.provenTopK,
    discardedCount: candidateResult.discardedPaths.length,
    discardedCoverageSafe: proof.discardedCoverageSafe,
  }
}

async function runShadow(job: ShadowJob) {
  shadowRunning = true
  const started = performance.now()
  const isStale = () => job.generation !== shadowGeneration
  const stageCtx: ShadowExecutorContext = {
    isStale,
    stage: recordStage,
    check: (stage) => {
      recordStage(stage)
      throwIfStale(isStale, stage)
    },
  }
  recordStage("create")
  const publishStale = () => {
    recordStage("publish")
    shadowStats.stale++
    shadowStats.wastedProviderMs += performance.now() - started
    job.resolve(skippedShadow("stale", performance.now() - started))
  }
  try {
    // Test-executor lane (offline): the fake models pipe-wait/paging/decode
    // stages cooperatively via ctx.check so abort actually reduces simulated
    // CPU/IPC instead of merely being scheduled.
    if (shadowExecutorForTests) {
      const provided = await shadowExecutorForTests(
        { root: job.input.root, query: job.input.query, initialCount: job.input.count, ignore: job.input.ignore },
        stageCtx,
      )
      if (isStale()) {
        publishStale()
        return
      }
      if (provided.status === "busy") {
        recordStage("publish")
        shadowStats.busy++
        job.resolve(skippedShadow("busy", performance.now() - started))
        return
      }
      if (provided.status === "unavailable") {
        recordStage("publish")
        shadowStats.unavailable++
        job.resolve(skippedShadow("unavailable", performance.now() - started, provided))
        return
      }
      // TEST-EXECUTOR SEAM ONLY (production CandidateSearch always carries real
      // discardedPaths from searchCandidatesDetailed). Offline fixtures model
      // enumerated candidates and may omit discards entirely, and `[]` is the
      // honest value for them: nothing was discarded, so discardedCoverageSafe
      // is vacuously true. If this seam is ever wired to a production provider,
      // that same `[]` would silently CERTIFY on forgotten discards (see
      // semantic-parity + ipc-runtime advisories). The assertion below keeps
      // this lane a fixture-only default rather than a proof-by-default.
      if (provided.status === "measured" && provided.discardedPaths === undefined) {
        if (provided.basenameSubsequenceComplete) {
          throw new Error(
            "shadow test executor returned measured without discardedPaths; " +
              "a completed source that forgets its discards would certify unsoundly",
          )
        }
      }
      const normalized = {
        status: "measured" as const,
        paths: provided.paths,
        discardedPaths: [...(provided.discardedPaths ?? [])],
        basenameSubsequenceComplete: provided.basenameSubsequenceComplete,
        complete: provided.complete,
        requiredCount: provided.requiredCount,
        exhaustible: provided.exhaustible,
      }
      // RERANK + PROOF + PUBLISH guards for the injected lane: even a fake
      // that ignores isStale can never merge stale rows into a newer
      // generation because publication re-checks and measuredShadow re-checks.
      const comparison = measuredShadow(job.input, normalized, performance.now() - started, isStale)
      if (isStale()) {
        publishStale()
        return
      }
      recordStage("publish")
      shadowStats.measured++
      shadowStats.measuredProviderMs += performance.now() - started
      job.resolve(comparison)
      return
    }
    recordStage("pipe-wait")
    const candidateResult = await Effect.runPromise(
      searchCandidatesExhaustiveDetailed(
        {
          root: job.input.root,
          query: job.input.query,
          initialCount: job.input.count,
          ignore: job.input.ignore,
        },
        shadowClient,
        isStale,
      ),
    )
    // PUBLICATION leak point (final guard): the only place a result crosses
    // into a caller-visible ShadowComparison. Older generations resolve with
    // zero coverage and can never contribute candidate rows.
    if (isStale()) {
      publishStale()
    } else if (candidateResult.status === "busy") {
      recordStage("publish")
      shadowStats.busy++
      job.resolve(skippedShadow("busy", performance.now() - started))
    } else if (candidateResult.status === "unavailable") {
      recordStage("publish")
      shadowStats.unavailable++
      job.resolve(skippedShadow("unavailable", performance.now() - started, candidateResult))
    } else {
      const comparison = measuredShadow(job.input, candidateResult, performance.now() - started, isStale)
      if (isStale()) {
        publishStale()
      } else {
        recordStage("publish")
        shadowStats.measured++
        shadowStats.measuredProviderMs += performance.now() - started
        job.resolve(comparison)
      }
    }
  } catch (error) {
    if (error instanceof StaleError) {
      recordAbort(error.stage)
      publishStale()
      return
    }
    recordStage("publish")
    if (isStale()) {
      shadowStats.stale++
      shadowStats.wastedProviderMs += performance.now() - started
      job.resolve(skippedShadow("stale", performance.now() - started))
    } else {
      shadowStats.unavailable++
      job.resolve(skippedShadow("unavailable", performance.now() - started))
    }
  } finally {
    shadowRunning = false
    const next = shadowPending
    shadowPending = undefined
    if (next) void runShadow(next)
  }
}

export function compareShadow(input: ShadowInput) {
  return Effect.promise(
    () =>
      new Promise<ShadowComparison>((resolve) => {
        const job: ShadowJob = {
          generation: ++shadowGeneration,
          input,
          resolve,
        }
        shadowStats.started++
        if (!shadowRunning) {
          void runShadow(job)
          return
        }
        // CREATION coalescing: only the newest pending generation survives.
        // Intermediate keystrokes resolve stale with zero provider work and
        // zero coverage, so latest-wins never fans out into N round trips.
        const superseded = shadowPending
        shadowPending = job
        if (superseded) {
          recordStage("create")
          shadowStats.stale++
          superseded.resolve(skippedShadow("stale"))
        }
      }),
  )
}