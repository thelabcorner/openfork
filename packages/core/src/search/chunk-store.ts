export * as ChunkStore from "./chunk-store"

import { constants, zstdCompressSync } from "node:zlib"
import fs from "fs"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { OCDBFrameError, decodeValueBytesRaw } from "../database/json-codec"
import { Hash } from "../util/hash"
import { FrontCodeError, appendVarint, crc32, decodeVarint, frontDecode, frontEncode } from "./front-code"

/**
 * Persistent chunk store for the realtime search index: one SQLite file per
 * project root holding front-coded + zstd-3-compressed entry chunks (the
 * storage-race winner: 30-69x compression, ~5ms full loads at 100k entries).
 *
 * Schema:
 *   meta(key TEXT PRIMARY KEY, value TEXT)      — schemaVersion / root / digest
 *   idx_chunk(seq INTEGER PRIMARY KEY, kind INTEGER NOT NULL,
 *             raw_len INTEGER NOT NULL, crc INTEGER NOT NULL, data BLOB NOT NULL)
 *
 * `kind` separates the two first-class entry streams (files vs directories);
 * each stream is independently front-coded + sealed, so directories are stored
 * and loaded exactly like files — never derived at query time. `raw_len` is
 * the UNCOMPRESSED payload byte length (sanity-checked after decode); `crc`
 * covers the bytes exactly as stored (frame or verbatim), so corruption is
 * detected before any decompression work.
 */

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Search/ChunkStore") {}

/** Entry-stream kinds: directories are a first-class stream, not derivations. */
export const KIND_FILE = 0
export const KIND_DIR = 1

/** Entries of one chunk, already sorted with {@link compareBytes}. */
export interface ChunkInput {
  readonly kind: number
  readonly entries: Uint8Array[]
}

export interface StoredChunk {
  readonly count: number
  readonly paths: string[]
}

/**
 * A decoded-to-BYTES chunk: CRC verified, decompressed, count prefix stripped,
 * but entries NOT materialized as JS strings. Front-coding is prefix-relative,
 * so byte-level scanning over `body` is the cheapest query-side shape (the
 * bench's "bytes-only" model); strings decode lazily via {@link Interface.decodeChunk}.
 */
export interface RawChunk {
  readonly seq: number
  readonly count: number
  readonly body: Uint8Array
}

/** SQL/driver failures, normalized so callers handle one store error shape. */
export class StoreError extends Error {
  constructor(operation: string, cause: unknown) {
    super(`index store ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = "ChunkStoreError"
  }
}

export interface Interface {
  readonly getMeta: (key: string) => Effect.Effect<string | undefined, StoreError>
  readonly putMeta: (key: string, value: string) => Effect.Effect<void, StoreError>
  /** Appends chunks; each row gets an auto-assigned sequence number. */
  readonly append: (chunks: ChunkInput[]) => Effect.Effect<void, StoreError>
  /** Sequential scan of one kind in seq order — CRC-verified, fail-closed per chunk. */
  readonly readAll: (kind: number) => Effect.Effect<StoredChunk[], StoreError | OCDBFrameError | FrontCodeError>
  /**
   * Same scan without string materialization — the hot query path. Match
   * against `body` bytes directly; call {@link Interface.decodeChunk} only for
   * final top-K rows.
   */
  readonly readRaw: (kind: number) => Effect.Effect<RawChunk[], StoreError | OCDBFrameError | FrontCodeError>
  /** Materializes one chunk's entries as strings (O(entries), prefix-relative). */
  readonly decodeChunk: (seq: number) => Effect.Effect<string[], StoreError | OCDBFrameError | FrontCodeError>
  readonly count: () => Effect.Effect<number, StoreError>
  /** Removes all chunk rows; meta rows are kept (root/schemaVersion survive). */
  readonly clear: () => Effect.Effect<void, StoreError>
}

export const SCHEMA_VERSION = "1"

/** Per-project index DB path — replaces the legacy JSON at the same directory. */
export function dbPathFor(root: string, dataDir: string): string {
  return path.join(dataDir, "file-index", `${Hash.sha256(root)}.db`)
}

// ---------------------------------------------------------------------------
// OCDB frame (FORMAT.md v3) over binary chunk payloads
// ---------------------------------------------------------------------------

const MAGIC = new Uint8Array([0x4f, 0x43, 0x44, 0x42]) // "OCDB"
const HEADER = 14
const VERSION = 3 // CRC over COMPRESSED bytes — verified before decompress
const CODEC_ZSTD = 1
const ZSTD_LEVEL = 3 // benchmark verdict
const RAWLEN_PRE_CAP = 128 * 1024 * 1024

/**
 * Chunk payload layout: varint(entryCount) ++ front-coded entries. The count
 * prefix makes every chunk self-describing so delta chunks (any size) decode
 * without external bookkeeping.
 *
 * The frame is emitted here instead of via json-codec's compressText because
 * front-coded streams are NOT guaranteed valid UTF-8 (a shared prefix can end
 * mid-multibyte-character), and compressText round-trips through a JS string.
 * The header layout matches FORMAT.md v3 byte-for-byte; decoding reuses the
 * repo's fail-closed decoder (decodeValueBytesRaw) which also accepts verbatim
 * (unframed) payloads forever.
 */
function packChunk(entries: Uint8Array[]): { packed: Uint8Array; framed: Uint8Array } {
  const body = frontEncode(entries)
  const packed = new Uint8Array(body.length + 5)
  const len = appendVarint(packed, 0, entries.length)
  packed.set(body, len)
  const raw = packed.subarray(0, len + body.length)
  const compressed = zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } })
  if (compressed.byteLength + HEADER >= raw.byteLength) return { packed: raw, framed: raw }
  const out = new Uint8Array(HEADER + compressed.byteLength)
  out.set(MAGIC)
  out[4] = VERSION
  out[5] = CODEC_ZSTD
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength)
  view.setUint32(6, raw.byteLength, true)
  view.setUint32(10, crc32(compressed), true)
  out.set(compressed, HEADER)
  return { packed: raw, framed: out }
}

function verifyChunk(data: Uint8Array, storedCrc: number, rawLen: number): { count: number; body: Uint8Array } {
  if (crc32(data) !== storedCrc) throw new OCDBFrameError("index chunk CRC mismatch")
  if (data.byteLength > RAWLEN_PRE_CAP) throw new OCDBFrameError(`index chunk exceeds pre-cap: ${data.byteLength}`)
  const raw = decodeValueBytesRaw(data)
  if (raw.byteLength !== rawLen) throw new OCDBFrameError(`index chunk length mismatch: expected ${rawLen}, got ${raw.byteLength}`)
  const head = decodeVarint(raw, 0)
  return { count: head.value, body: raw.subarray(head.pos) }
}

function unpackChunk(data: Uint8Array, storedCrc: number, rawLen: number): StoredChunk {
  const { count, body } = verifyChunk(data, storedCrc, rawLen)
  return { count, paths: frontDecode(body, count) }
}

// ---------------------------------------------------------------------------
// Raw SQLite access (bun first, node fallback — same pattern as chunk-compact)
// ---------------------------------------------------------------------------

interface RawDb {
  run: (sql: string, params?: ReadonlyArray<unknown>) => void
  all: (sql: string, params?: ReadonlyArray<unknown>) => Array<Record<string, unknown>>
  close: () => void
}

function openRaw(filename: string): RawDb {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = require("bun:sqlite") as { Database: new (f: string) => any }
    const db = new Database(filename)
    return {
      run: (sql, params) => (params === undefined ? db.run(sql) : db.run(sql, params)),
      all: (sql, params) => (params === undefined ? (db.query(sql).all() ?? []) : (db.query(sql).all(...params) ?? [])),
      close: () => {
        try {
          db.run("PRAGMA wal_checkpoint(TRUNCATE)")
        } catch {}
        db.close()
      },
    }
  } catch {}
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (f: string) => any }
  const db = new DatabaseSync(filename)
  return {
    run: (sql, params) => (params === undefined ? db.exec(sql) : db.prepare(sql).run(...params)),
    all: (sql, params) => (params === undefined ? (db.prepare(sql).all() ?? []) : (db.prepare(sql).all(...params) ?? [])),
    close: () => db.close(),
  }
}

// ---------------------------------------------------------------------------
// Layer
// ---------------------------------------------------------------------------

export const layerFromPath = (filename: string) => {
  // Opened while the layer is being built, before the effect body below runs.
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const db = openRaw(filename)
      // Closed on THIS service's scope — consumers must provide the layer
      // around their whole body effect, not a single service yield.
      yield* Effect.addFinalizer(() => Effect.sync(() => db.close()))
      const DDL = [
        "PRAGMA journal_mode = WAL",
        "PRAGMA synchronous = NORMAL",
        "PRAGMA busy_timeout = 5000",
        "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        "CREATE TABLE IF NOT EXISTS idx_chunk (seq INTEGER PRIMARY KEY, kind INTEGER NOT NULL, raw_len INTEGER NOT NULL, crc INTEGER NOT NULL, data BLOB NOT NULL)",
      ]
      for (const sql of DDL) db.run(sql)

      const sqlEffect = <A>(operation: string, body: () => A) =>
        Effect.try({
          try: body,
          catch: (cause) => new StoreError(operation, cause),
        })

      const decodeRow = (row: Record<string, unknown>): StoredChunk => {
        const data = row.data instanceof Uint8Array ? row.data : undefined
        if (!data) throw new OCDBFrameError(`index chunk row has non-BLOB data (${typeof row.data})`)
        return unpackChunk(data, Number(row.crc), Number(row.raw_len))
      }
      const decodeRowRaw = (row: Record<string, unknown>): RawChunk => {
        const data = row.data instanceof Uint8Array ? row.data : undefined
        if (!data) throw new OCDBFrameError(`index chunk row has non-BLOB data (${typeof row.data})`)
        return { seq: Number(row.seq), ...verifyChunk(data, Number(row.crc), Number(row.raw_len)) }
      }
      const wrapDecode = <A>(decode: () => A[]) =>
        Effect.try({
          try: decode,
          catch: (cause) =>
            cause instanceof OCDBFrameError || cause instanceof FrontCodeError
              ? cause
              : new OCDBFrameError(`chunk decode failed: ${String(cause)}`),
        })

      return Service.of({
        getMeta: (key) =>
          sqlEffect("getMeta", () => db.all("SELECT value FROM meta WHERE key = ?", [key])).pipe(
            Effect.map((rows) => (rows.length === 0 ? undefined : String(rows[0]!.value))),
          ),
        putMeta: (key, value) =>
          sqlEffect("putMeta", () =>
            db.run("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]),
          ).pipe(Effect.asVoid),
        append: (chunks) =>
          Effect.forEach(chunks, (chunk) =>
            sqlEffect("append", () => {
              const { packed, framed } = packChunk(chunk.entries)
              db.run("INSERT INTO idx_chunk(kind, raw_len, crc, data) VALUES (?, ?, ?, ?)", [
                chunk.kind,
                packed.byteLength,
                crc32(framed),
                framed,
              ])
            }),
          ).pipe(Effect.asVoid),
        readAll: (kind) =>
          sqlEffect("readAll", () => db.all("SELECT raw_len, crc, data FROM idx_chunk WHERE kind = ? ORDER BY seq", [kind])).pipe(
            Effect.flatMap((rows) => wrapDecode(() => rows.map(decodeRow))),
          ),
        readRaw: (kind) =>
          sqlEffect("readRaw", () => db.all("SELECT seq, raw_len, crc, data FROM idx_chunk WHERE kind = ? ORDER BY seq", [kind])).pipe(
            Effect.flatMap((rows) => wrapDecode(() => rows.map(decodeRowRaw))),
          ),
        decodeChunk: (seq) =>
          sqlEffect("decodeChunk", () => db.all("SELECT raw_len, crc, data FROM idx_chunk WHERE seq = ?", [seq])).pipe(
            Effect.flatMap((rows) =>
              rows.length === 0
                ? Effect.succeed([])
                : wrapDecode(() => {
                    const raw = decodeRowRaw({ ...rows[0]!, seq })
                    return frontDecode(raw.body, raw.count)
                  }),
            ),
          ),
        count: () =>
          sqlEffect("count", () => db.all("SELECT COUNT(*) AS n FROM idx_chunk")).pipe(
            Effect.map((rows) => Number(rows[0]!.n)),
          ),
        clear: () => sqlEffect("clear", () => db.run("DELETE FROM idx_chunk")).pipe(Effect.asVoid),
      })
    }),
  )
}


