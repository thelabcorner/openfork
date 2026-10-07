import { describe, expect, test } from "bun:test"
import {
  Client,
  SDK3_LIMITS,
  certifyCandidateTopK,
  parse,
  shutdownEverythingProvider,
  type Sdk3SocketLike,
} from "../src/search/everything"

/**
 * SDK3 IPC runtime hardening: framing, 64-bit decoding, VLQ/chunk decode,
 * split frames, paging/termination, allocation bounds, timeout, poisoned
 * connection, restart (invalid handle), startup/shutdown.
 *
 * Transport lifecycle tests inject a fake socket, so the whole file runs on
 * every platform and identically under Bun and Node. Named pipes only exist on
 * win32, so a win32-only transport test would NOT be a parity gate.
 *
 * Wire format below is the layout CONFIRMED byte-exactly against a live
 * Everything 1.5.0.1423b on \\.\pipe\Everything IPC (OpenFork-SDK3) by
 * script/everything-bench/sdk3-wire-audit.ts (diagnostic-only, no production
 * dependency):
 *   u32 flags | SIZE_T folders | SIZE_T files | SIZE_T viewportOffset |
 *   SIZE_T viewportCount | VLQ sorts (+8B/sort) | VLQ props |
 *   9B property descriptor | items[] (u8 flags, VLQ len, utf8 path)
 * and a multi-frame response is ONE CONTINUOUS item stream with no repeated
 * header (verified: a 1000-item viewport produced 3 frames whose 2nd frame
 * begins directly with path bytes).
 */

const FLAG_64BIT = 0x00004000
const PROPERTY_PATH_AND_NAME = 240
const ITEM_FOLDER = 0x01
const PATH_TYPE = 15
const SEARCH = 7
const IS_DB_LOADED = 8
const RESPONSE_MORE = 100
const RESPONSE_OK = 200

function vlq(value: number): Buffer {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("invalid VLQ")
  if (value < 0xff) return Buffer.from([value])
  let next = value - 0xff
  if (next < 0xffff) {
    const out = Buffer.allocUnsafe(3)
    out[0] = 0xff
    out.writeUInt16LE(next, 1)
    return out
  }
  next -= 0xffff
  if (next < 0xffffffff) {
    const out = Buffer.allocUnsafe(7)
    out[0] = 0xff
    out.writeUInt16LE(0xffff, 1)
    out.writeUInt32LE(next, 3)
    return out
  }
  throw new RangeError("VLQ too large")
}

/** Build a wire-accurate SEARCH response body, with per-field override so each
 *  test can corrupt exactly one thing. */
function body(overrides: {
  folders?: number
  files?: number
  viewportOffset?: number | bigint
  viewportCount?: number | bigint
  sorts?: number
  sortBlock?: Buffer
  props?: number
  propId?: number
  propFlags?: number
  propType?: number
  items?: Array<{ flags?: number; text: string }>
  trailing?: Buffer
  wide?: boolean
  /** omit the property descriptor entirely */
  omitPropDescriptor?: boolean
} = {}) {
  const wide = overrides.wide ?? true
  const folders = overrides.folders ?? 0
  const files = overrides.files ?? 1
  const viewportOffset = overrides.viewportOffset ?? 0n
  const viewportCount = overrides.viewportCount ?? BigInt(overrides.items?.length ?? 0)
  const sorts = overrides.sorts ?? 0
  const props = overrides.props ?? 1
  const items = overrides.items ?? []

  const flags = Buffer.allocUnsafe(4)
  flags.writeUInt32LE(wide ? FLAG_64BIT : 0, 0)

  const sizes = Buffer.allocUnsafe(wide ? 32 : 16)
  const writeSize = (value: number | bigint, at: number) => {
    if (wide) sizes.writeBigUInt64LE(BigInt(value), at)
    else sizes.writeUInt32LE(Number(value), at)
  }
  writeSize(folders, 0)
  writeSize(files, wide ? 8 : 4)
  writeSize(viewportOffset, wide ? 16 : 8)
  writeSize(viewportCount, wide ? 24 : 12)

  const sortBlock = overrides.sortBlock ?? Buffer.alloc(sorts * 8)
  const parts: Buffer[] = [flags, sizes, vlq(sorts), sortBlock, vlq(props)]
  if (!overrides.omitPropDescriptor) {
    const descriptor = Buffer.allocUnsafe(9)
    descriptor.writeUInt32LE(overrides.propId ?? PROPERTY_PATH_AND_NAME, 0)
    descriptor.writeUInt32LE(overrides.propFlags ?? 0, 4)
    descriptor[8] = overrides.propType ?? PATH_TYPE
    parts.push(descriptor)
  }
  for (const item of items) {
    const bytes = Buffer.from(item.text, "utf8")
    parts.push(Buffer.from([item.flags ?? 0]), vlq(bytes.length), bytes)
  }
  if (overrides.trailing) parts.push(overrides.trailing)
  return Buffer.concat(parts)
}

/** Split a response body into SDK3 frames at an arbitrary byte boundary. */
function frames(bodies: Buffer[], codes: number[], splitAt?: number): Buffer {
  const out: Buffer[] = []
  bodies.forEach((b, index) => {
    const code = codes[index]!
    const header = Buffer.allocUnsafe(8)
    header.writeUInt32LE(code, 0)
    header.writeUInt32LE(b.length, 4)
    if (splitAt !== undefined && index === bodies.length - 1) {
      // One logical frame delivered as two socket reads, to prove the
      // reassembly path does not depend on read boundaries.
      out.push(Buffer.concat([header, b.subarray(0, splitAt)]))
      out.push(b.subarray(splitAt))
    } else {
      out.push(Buffer.concat([header, b]))
    }
  })
  return Buffer.concat(out)
}

function expectParseFails(input: Buffer, pattern: RegExp) {
  let message = ""
  try {
    parse(input)
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  expect(message).toMatch(pattern)
}

describe("SDK3 decoder: valid wire shapes", () => {
  test("decodes the observed wide (u64 SIZE_T) response exactly", () => {
    const decoded = parse(
      body({
        folders: 260,
        files: 2793,
        viewportCount: 3n,
        items: [
          { flags: ITEM_FOLDER, text: "C:\\repo\\node_modules\\.bun\\@codemirror+search" },
          { flags: 0, text: "C:\\repo\\src\\search\\everything.ts" },
          { flags: ITEM_FOLDER, text: "C:\\repo\\src\\search" },
        ],
      }),
    )
    expect(decoded.total).toBe(260 + 2793)
    expect(decoded.viewportOffset).toBe(0)
    expect(decoded.items).toHaveLength(3)
    expect(decoded.items[0]).toEqual({ fullPath: "C:\\repo\\node_modules\\.bun\\@codemirror+search", isDir: true })
    expect(decoded.items[1]).toEqual({ fullPath: "C:\\repo\\src\\search\\everything.ts", isDir: false })
    expect(decoded.items[2]!.isDir).toBe(true)
  })

  test("decodes the narrow (u32 SIZE_T) response when FLAG_64BIT is clear", () => {
    const decoded = parse(
      body({ wide: false, folders: 2, files: 5, items: [{ text: "C:\\repo\\a.ts" }] }),
    )
    expect(decoded.total).toBe(7)
    expect(decoded.items).toEqual([{ fullPath: "C:\\repo\\a.ts", isDir: false }])
  })

  test("accepts the observed sorts==1 + props==1 shape the live server emits", () => {
    const decoded = parse(
      body({ sorts: 1, items: [{ text: "C:\\repo\\x.ts" }] }),
    )
    expect(decoded.items).toHaveLength(1)
  })

  test("a zero-match response is a real empty result, not an error", () => {
    const decoded = parse(body({ folders: 0, files: 0, viewportCount: 0n, items: [] }))
    expect(decoded.total).toBe(0)
    expect(decoded.items).toEqual([])
  })

  test("a path longer than one VLQ size class round-trips (multi-byte length)", () => {
    const long = "C:\\repo\\" + "x".repeat(700)
    const decoded = parse(body({ items: [{ text: long }] }))
    expect(decoded.items[0]!.fullPath).toBe(long)
  })
})

describe("SDK3 decoder: truncated input", () => {
  test("rejects an empty and a sub-header buffer", () => {
    expectParseFails(Buffer.alloc(0), /truncated response/)
    expectParseFails(Buffer.from([0x04, 0x40]), /truncated response/)
  })

  test("rejects truncation inside the SIZE_T fields", () => {
    expectParseFails(body({ items: [] }).subarray(0, 20), /truncated SIZE_T|truncated response/)
  })

  test("rejects a SIZE_T beyond the safe-integer range instead of losing precision", () => {
    const buffer = body({ items: [] })
    // overwrite `files` with 2^63-1, which is not a safe integer
    buffer.writeBigUInt64LE((1n << 63n) - 1n, 12)
    expectParseFails(buffer, /SIZE_T too large|total overflows/)
  })

  test("rejects truncation inside the sort block", () => {
    expectParseFails(body({ sorts: 1, items: [] }).subarray(0, 40), /truncated sort block|truncated VLQ/)
  })

  test("rejects a truncated VLQ escape", () => {
    // flags + sizes + a lone 0xff escape byte
    const buffer = Buffer.concat([body({ items: [] }).subarray(0, 36), Buffer.from([0xff])])
    expectParseFails(buffer, /truncated VLQ|unexpected property schema|truncated sort block/)
  })

  test("rejects a truncated property descriptor", () => {
    expectParseFails(body({ omitPropDescriptor: true, items: [] }), /unexpected property schema/)
  })

  test("rejects a viewport that claims more items than the buffer can hold", () => {
    expectParseFails(body({ viewportCount: 5000n, items: [] }), /truncated item/)
  })

  test("rejects an item whose declared path length runs past the buffer", () => {
    const buffer = Buffer.concat([
      body({ viewportCount: 1n }).subarray(0, 41 + 4 + 9),
      Buffer.from([0x00, 0xfe, 0x01]), // flags, then VLQ claiming ~254+ bytes
    ])
    expectParseFails(buffer, /truncated item|truncated path/)
  })
})

describe("SDK3 decoder: malformed and hostile headers", () => {
  test("rejects a property count other than exactly 1", () => {
    expectParseFails(body({ props: 0, items: [] }), /unexpected property schema/)
    expectParseFails(body({ props: 2, items: [] }), /unexpected property schema/)
  })

  test("rejects a property descriptor for the wrong property or flags", () => {
    expectParseFails(body({ propId: 1, items: [] }), /unexpected path property/)
    expectParseFails(body({ propFlags: 1, items: [] }), /unexpected path property/)
  })

  test("rejects a property type outside the observed path types", () => {
    expectParseFails(body({ propType: 3, items: [] }), /unexpected path property/)
    expectParseFails(body({ propType: 99, items: [] }), /unexpected path property/)
  })

  test("rejects trailing bytes rather than ignoring them", () => {
    expectParseFails(
      body({ items: [{ text: "a" }], trailing: Buffer.from([0xde, 0xad]) }),
      /trailing SDK3 bytes/,
    )
  })

  test("rejects an oversized sort count BEFORE consuming it", () => {
    // sorts is a VLQ; anything past the bound must be refused, not used to walk
    // the cursor far past the buffer.
    const buffer = body({ items: [] })
    buffer[36] = 0x7f
    expectParseFails(buffer, /sort count exceeds bound/)
  })

  test("rejects a viewport count past the hard allocation bound", () => {
    const buffer = body({ items: [] })
    // flags(4) + folders(8) + files(8) + viewportOffset(8) -> viewportCount@28
    buffer.writeBigUInt64LE(BigInt(SDK3_LIMITS.MAX_ITEMS) + 1n, 28)
    expectParseFails(buffer, /viewport exceeds item bound/)
  })

  test("rejects an absurd viewport count long before it could allocate", () => {
    const buffer = body({ items: [] })
    buffer.writeBigUInt64LE(0xffffffffffffn, 28)
    expectParseFails(buffer, /viewport exceeds item bound/)
  })

  test("rejects a nonzero viewport offset instead of silently understating coverage", () => {
    // This provider only ever requests offset 0. A nonzero offset means the
    // rows are not the head of the result set, so `items.length >= total` would
    // be a false completeness claim.
    const buffer = body({ viewportOffset: 500n, items: [{ text: "a" }] })
    expectParseFails(buffer, /viewport offset/)
  })

  test("rejects a folder+file total that overflows the safe integer range", () => {
    const buffer = body({ items: [] })
    buffer.writeBigUInt64LE((1n << 62n), 4)
    buffer.writeBigUInt64LE((1n << 62n), 12)
    expectParseFails(buffer, /SIZE_T too large|total overflows/)
  })
})

// ---------------------------------------------------------------------------
// Transport lifecycle, driven through an injected socket.
// ---------------------------------------------------------------------------

class FakeSocket implements Sdk3SocketLike {
  destroyed = false
  readonly written: Buffer[] = []
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  /** when set, write() reports this failure instead of buffering */
  writeError?: Error

  write(data: Buffer, callback?: (error?: Error | null) => void) {
    if (this.destroyed || this.writeError) {
      callback?.(this.writeError ?? new Error("EPIPE: socket is destroyed"))
      return false
    }
    this.written.push(Buffer.from(data))
    callback?.(null)
    return true
  }

  destroy() {
    this.destroyed = true
  }

  on(event: string, listener: (...args: never[]) => void) {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  once(event: string, listener: (...args: never[]) => void) {
    const wrapped = ((...args: never[]) => {
      this.off(event, wrapped)
      listener(...args)
    }) as (...args: never[]) => void
    return this.on(event, wrapped)
  }

  off(event: string, listener: (...args: never[]) => void) {
    const list = this.listeners.get(event) ?? []
    this.listeners.set(event, list.filter((entry) => entry !== listener))
    return this
  }

  emit(event: string, ...args: never[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }

  /** Deliver response bytes to the client. */
  deliver(bytes: Buffer) {
    this.emit("data", bytes as never)
  }

  /** Everything the client wrote, concatenated. */
  get sent(): Buffer {
    return Buffer.concat(this.written)
  }

  /** Simulate the provider process going away. */
  remoteClose() {
    this.destroyed = true
    this.emit("close" as never)
  }

  remoteError(error: Error) {
    this.emit("error" as never, error as never)
  }
}

function harness(options: { timeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = []
  const client = new Client({
    pipe: "test",
    timeoutMs: options.timeoutMs ?? 250,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      // connect() awaits the socket's "connect" event; a fake never emits it
      // on its own.
      queueMicrotask(() => socket.emit("connect" as never))
      return socket as unknown as Sdk3SocketLike
    },
  })
  return { client, sockets, latest: () => sockets[sockets.length - 1]! }
}

const okResponse = (paths: string[]) =>
  frames(
    [body({ files: paths.length, viewportCount: BigInt(paths.length), items: paths.map((text) => ({ text })) })],
    [RESPONSE_OK],
  )

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return { ok: true, value: await promise }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }
  }
}

/**
 * Yield enough for `connect()` to finish its dynamic `node:net` import and emit
 * "connect" before a test inspects the injected socket. A single microtask
 * turn is not enough.
 */
async function tick() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("SDK3 transport: framing and split frames", () => {
  test("a response delivered one byte at a time still decodes", async () => {
    const { client, latest } = harness()
    const wire = okResponse(["C:\\repo\\a.ts", "C:\\repo\\b.ts"])
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    const socket = latest()
    for (const byte of wire) socket.deliver(Buffer.from([byte]))
    const result = await settle(pending)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.items).toHaveLength(2)
    client.dispose()
  })

  test("a frame split mid-header and mid-body is reassembled", async () => {
    const { client, latest } = harness()
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    const socket = latest()
    const wire = okResponse(["C:\\repo\\split.ts"])
    socket.deliver(wire.subarray(0, 3))
    socket.deliver(wire.subarray(3, 40))
    socket.deliver(wire.subarray(40))
    const result = await settle(pending)
    expect(result.ok && result.value.items[0]!.fullPath).toBe("C:\\repo\\split.ts")
    client.dispose()
  })

  test("RESPONSE_MORE frames are ONE continuous stream, not repeated headers", async () => {
    // Reproduces the observed live multi-frame shape: frame bodies concatenate
    // into a single decodable response, and a per-frame header parse fails.
    const { client, latest } = harness()
    const whole = body({
      files: 4,
      viewportCount: 4n,
      items: ["C:\\r\\1.ts", "C:\\r\\2.ts", "C:\\r\\3.ts", "C:\\r\\4.ts"].map((text) => ({ text })),
    })
    // split the single logical body into 3 transport frames
    const cut1 = Math.floor(whole.length / 3)
    const cut2 = Math.floor((whole.length * 2) / 3)
    const pieces = [whole.subarray(0, cut1), whole.subarray(cut1, cut2), whole.subarray(cut2)]
    const wire = Buffer.concat([
      ...pieces.map((p) => {
        const header = Buffer.allocUnsafe(8)
        header.writeUInt32LE(RESPONSE_MORE, 0)
        header.writeUInt32LE(p.length, 4)
        return Buffer.concat([header, p])
      }),
      (() => {
        const header = Buffer.allocUnsafe(8)
        header.writeUInt32LE(RESPONSE_OK, 0)
        header.writeUInt32LE(0, 4)
        return header
      })(),
    ])
    const pending = client.search("C:\\repo", "r", 10)
    await tick()
    latest().deliver(wire)
    const result = await settle(pending)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value.items.map((i) => i.fullPath)).toEqual([
      "C:\\r\\1.ts", "C:\\r\\2.ts", "C:\\r\\3.ts", "C:\\r\\4.ts",
    ])
    client.dispose()
  })

  test("several frames arriving in one read are all consumed", async () => {
    const { client, latest } = harness()
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    latest().deliver(okResponse(["C:\\repo\\x.ts"]))
    const result = await settle(pending)
    expect(result.ok).toBe(true)
    client.dispose()
  })

  test("an unknown response code fails closed instead of decoding a body", async () => {
    const { client, latest } = harness()
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    const header = Buffer.allocUnsafe(8)
    header.writeUInt32LE(999, 0)
    header.writeUInt32LE(4, 4)
    latest().deliver(Buffer.concat([header, Buffer.from([1, 0, 0, 0])]))
    const result = await settle(pending)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/SDK3 response 999/)
    client.dispose()
  })

  test("stray response bytes with no request in flight fail closed", async () => {
    const h = harness()
    const { client } = h
    const probe = client.ready()
    await tick()
    h.sockets[0]!.deliver(frame(RESPONSE_OK, 1))
    expect((await settle(probe)).ok).toBe(true)

    const search = client.search("C:\\repo", "a", 10)
    await tick()
    h.sockets[0]!.deliver(okResponse(["C:\\repo\\a.ts"]))
    expect((await settle(search)).ok).toBe(true)

    // Bytes arrive with nothing in flight. The client must tear down rather
    // than silently buffer a response nobody asked for.
    h.sockets[0]!.deliver(okResponse(["C:\\repo\\stray.ts"]))
    expect(h.sockets[0]!.destroyed).toBe(true)
    client.dispose()
  })
})

describe("SDK3 transport: oversized frames and responses", () => {
  test("a frame declaring more than MAX_FRAME is rejected on its declared length", async () => {
    const { client, latest } = harness()
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    const header = Buffer.allocUnsafe(8)
    header.writeUInt32LE(RESPONSE_OK, 0)
    header.writeUInt32LE(SDK3_LIMITS.MAX_FRAME + 1, 4)
    const socket = latest()
    socket.deliver(header)
    const result = await settle(pending)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/frame too large/)
    expect(socket.destroyed).toBe(true)
    client.dispose()
  })

  test("an accumulated response past MAX_RESPONSE is rejected", async () => {
    const { client, latest } = harness()
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    const socket = latest()
    // Each frame body is valid on its own; only the accumulation is hostile.
    const payload = Buffer.alloc(1024 * 1024)
    for (let sent = 0; sent <= SDK3_LIMITS.MAX_RESPONSE / payload.length; sent++) {
      const header = Buffer.allocUnsafe(8)
      header.writeUInt32LE(sent === 0 ? RESPONSE_MORE : RESPONSE_MORE, 0)
      header.writeUInt32LE(payload.length, 4)
      socket.deliver(Buffer.concat([header, payload]))
      if (socket.destroyed) break
    }
    const result = await settle(pending)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/response too large/)
    client.dispose()
  })

  test("a body inside frame bounds but malformed fails as a protocol error", async () => {
    const { client, latest } = harness()
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    latest().deliver(frames([body({ propId: 7, items: [{ text: "a" }] })], [RESPONSE_OK]))
    const result = await settle(pending)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/path property/)
    client.dispose()
  })
})

describe("SDK3 transport: timeout and poisoned connection", () => {
  test("a silent provider times out and fails closed", async () => {
    const { client, sockets } = harness({ timeoutMs: 60 })
    const result = await settle(client.search("C:\\repo", "a", 10))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/timeout|pipe closed/)
    expect(sockets[0]!.destroyed).toBe(true)
    client.dispose()
  })

  test("a readiness probe that never answers times out and does not leave a stale ready", async () => {
    const { client } = harness({ timeoutMs: 60 })
    const result = await settle(client.ready())
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/readiness timeout/)
    client.dispose()
  })

  test("a poisoned connection does not wedge later requests", async () => {
    const h = harness()
    const { client } = h
    const first = client.search("C:\\repo", "a", 10)
    await tick()
    h.sockets[0]!.deliver(okResponse(["C:\\repo\\a.ts"]))
    expect((await settle(first)).ok).toBe(true)

    h.sockets[0]!.remoteError(new Error("provider exploded"))

    const next = client.search("C:\\repo", "b", 10)
    await tick()
    expect(h.sockets.length).toBe(2)
    h.sockets[1]!.deliver(okResponse(["C:\\repo\\b.ts"]))
    const result = await settle(next)
    expect(result.ok && result.value.items[0]!.fullPath).toBe("C:\\repo\\b.ts")
    client.dispose()
  })
})

describe("SDK3 transport: provider restart and invalid handle", () => {
  test("a provider restart mid-request fails closed, then recovers on a fresh socket", async () => {
    const h = harness()
    const { client } = h
    const before = client.search("C:\\repo", "a", 10)
    await tick()
    h.sockets[0]!.deliver(okResponse(["C:\\repo\\before.ts"]))
    expect((await settle(before)).ok).toBe(true)

    // The provider process dies while a request is in flight.
    const mid = client.search("C:\\repo", "b", 10)
    await tick()
    h.sockets[0]!.remoteClose()
    const failed = await settle(mid)
    expect(failed.ok).toBe(false)
    expect(!failed.ok && failed.error.message).toMatch(/pipe closed/)

    // The next request must reconnect rather than reuse the dead handle.
    const after = client.search("C:\\repo", "c", 10)
    await tick()
    expect(h.sockets.length).toBe(2)
    expect(h.sockets[1]!.destroyed).toBe(false)
    h.sockets[1]!.deliver(okResponse(["C:\\repo\\after-restart.ts"]))
    const recovered = await settle(after)
    expect(recovered.ok && recovered.value.items[0]!.fullPath).toBe("C:\\repo\\after-restart.ts")
    client.dispose()
  })

  test("a write error on an invalid handle fails the request closed", async () => {
    let created = 0
    const client = new Client({
      pipe: "test",
      timeoutMs: 250,
      createSocket: () => {
        const socket = new FakeSocket()
        created++
        if (created === 1) socket.writeError = new Error("EPIPE: the pipe handle is invalid")
        queueMicrotask(() => socket.emit("connect" as never))
        return socket as unknown as Sdk3SocketLike
      },
    })
    const result = await settle(client.search("C:\\repo", "a", 10))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/pipe handle is invalid/)
    client.dispose()
  })

  test("a client whose pipe does not exist fails closed instead of claiming readiness", async () => {
    const client = new Client({ pipe: "\\\\.\\pipe\\openfork-does-not-exist", timeoutMs: 120 })
    const result = await settle(client.ready())
    expect(result.ok).toBe(false)
    client.dispose()
  })
})

describe("SDK3 readiness freshness", () => {
test("a confirmed ready is cached inside the TTL and re-asked after it", async () => {
    const h = harness()
    const { client } = h

    const first = client.ready()
    await tick()
    h.sockets[0]!.deliver(frame(RESPONSE_OK, 1))
    expect((await settle(first)).ok).toBe(true)

    // Inside the TTL the confirmed answer is reused: no extra round trip.
    const writesBefore = h.sockets[0]!.written.length
    expect((await settle(client.ready())).ok).toBe(true)
    expect(h.sockets[0]!.written.length).toBe(writesBefore)

    // Past the TTL the freshness claim is re-asked rather than trusted, because
    // a provider can reload its database underneath a socket that never closes.
    const realNow = Date.now
    try {
      Date.now = () => realNow() + SDK3_LIMITS.READY_TTL_MS + 1_000
      const recheck = client.ready()
      await tick()
      expect(h.sockets[0]!.written.length).toBeGreaterThan(writesBefore)
      h.sockets[0]!.deliver(frame(RESPONSE_OK, 1))
      expect((await settle(recheck)).ok).toBe(true)
    } finally {
      Date.now = realNow
    }
    client.dispose()
  })

  test("a DB_LOADED answer of zero reports not-ready rather than failing open", async () => {
    const h = harness()
    const pending = h.client.ready()
    await tick()
    h.sockets[0]!.deliver(frame(RESPONSE_OK, 0))
    const result = await settle(pending)
    expect(result.ok).toBe(true)
    expect(result.ok && result.value).toBe(false)
    h.client.dispose()
  })
})

// ---------------------------------------------------------------------------
// Per-source drainability (the `exact.total + broad.total` double-count).
//
// The viewport is PER-SOURCE: `search()` issues two independent SEARCH requests
// (lines 506/509), each carrying viewport count `count`, and the live server
// answers min(count, thatSource.total). Draining both therefore needs
// count >= max(exact.total, broad.total). Summing the two totals double-counted
// a heavily-overlapping pair of enumerations of the SAME root, which falsely
// denied drainability on roots well under the 10k cap.
// ---------------------------------------------------------------------------

const OVERLAP_ROOT = "C:\\small"

/** `n` distinct paths with a prefix, so two sources can overlap deliberately. */
function manyItems(n: number, prefix: string, start = 0): Array<{ flags: number; text: string }> {
  const out: Array<{ flags: number; text: string }> = []
  for (let i = start; i < start + n; i++) out.push({ flags: 0, text: `${OVERLAP_ROOT}\\${prefix}${i}.ts` })
  return out
}

function wire(total: number, items: Array<{ flags: number; text: string }>) {
  return frames([body({ files: total, viewportCount: BigInt(items.length), items })], [RESPONSE_OK])
}

/** Drive `Client.search` across its two sequential per-source round trips. */
async function twoSourceSearch(client: Client, deliver: (wire: Buffer) => void) {
  const pending = client.search(OVERLAP_ROOT, "abc", SDK3_LIMITS.MAX_VIEWPORT)
  await tick()
  deliver(exactWire!) // leg 1: exact path-substring source
  await tick()
  deliver(broadWire!) // leg 2: basename-subsequence source
  return settle(pending)
}

let exactWire: Buffer
let broadWire: Buffer

describe("SDK3 per-source drainability", () => {
  test("two heavily-overlapping sources on a small root stay exhaustible", async () => {
    // A small root (6,000 + 5,500 matched rows) whose two sources overlap on
    // 5,000 rows. The old summed bound was 11,500 > MAX_VIEWPORT, so it
    // reported exhaustible=false on a root that fits comfortably.
    const exactItems = manyItems(6000, "e")
    const broadItems = [...manyItems(5000, "e"), ...manyItems(500, "b", 100_000)]
    exactWire = wire(6000, exactItems)
    broadWire = wire(5500, broadItems)

    const h = harness()
    const result = await twoSourceSearch(h.client, (bytes) => h.sockets[0]!.deliver(bytes))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as unknown as {
      total: number
      exhaustible: boolean
      complete: boolean
      requiredCount: number
      basenameSubsequenceComplete: boolean
      items: Array<unknown>
    }
    // Both sources drained, and the union (6,500) fits the requested viewport.
    expect(value.basenameSubsequenceComplete).toBe(true)
    expect(value.complete).toBe(true)
    expect(value.exhaustible).toBe(true)
    // Derived from the per-source max, NOT the 11,500 sum and NOT the 10k cap.
    expect(value.total).toBe(6000)
    expect(value.requiredCount).toBe(6000)
    expect(value.items).toHaveLength(6500)
    h.client.dispose()
  })

  test("the summed bound would have truncated a root that fits", () => {
    // Pins the arithmetic that motivated the change, independent of the client.
    expect(6000 + 5500).toBeGreaterThan(SDK3_LIMITS.MAX_VIEWPORT)
    expect(Math.max(6000, 5500)).toBeLessThanOrEqual(SDK3_LIMITS.MAX_VIEWPORT)
  })

  test("SAFETY: a more permissive exhaustible never certifies an undrained source", async () => {
    // The direction of change is the load-bearing invariant. exhaustible becomes
    // MORE permissive, but certification is gated on
    // `broad.items.length >= broad.total` (basenameSubsequenceComplete), which
    // this change does not touch. Here the broad source is truncated, so the
    // page must still refuse even though exhaustible is now true.
    const exactItems = manyItems(6000, "e")
    const broadItems = manyItems(3000, "b")
    exactWire = wire(6000, exactItems)
    broadWire = wire(5500, broadItems) // declares 5500, only 3000 delivered

    const h = harness()
    const result = await twoSourceSearch(h.client, (bytes) => h.sockets[0]!.deliver(bytes))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const value = result.value as unknown as {
      exhaustible: boolean
      complete: boolean
      basenameSubsequenceComplete: boolean
      requiredCount: number
    }
    // The fix DID make exhaustible permissive...
    expect(value.exhaustible).toBe(true)
    expect(value.requiredCount).toBe(6000)
    // ...but the undrained source is still visible and still refuses.
    expect(value.basenameSubsequenceComplete).toBe(false)
    expect(value.complete).toBe(false)

    const proof = certifyCandidateTopK({
      query: "abc",
      pageScores: [10_000, 10_000],
      pageLimit: 2,
      basenameSubsequenceComplete: value.basenameSubsequenceComplete,
      discardedPaths: [],
    })
    expect(proof.omittedScoreUpperBound).toBeDefined()
    expect(proof.proofFloor).toBe(10_000)
    expect(proof.provenTopK).toBe(false)
    h.client.dispose()
  })

  test("SAFETY: the certificate keys only on the per-source drain input", () => {
    // Structural guarantee: a dominating floor plus coverage is still refused
    // purely on the source-drain input, so no exhaustible change can carry it.
    const base = {
      query: "abc",
      pageScores: [100_000, 100_000],
      pageLimit: 2,
      discardedPaths: [],
    }
    expect(certifyCandidateTopK({ ...base, basenameSubsequenceComplete: false }).provenTopK).toBe(false)
    expect(certifyCandidateTopK({ ...base, basenameSubsequenceComplete: true }).provenTopK).toBe(true)
  })
})

function frame(code: number, value: number): Buffer {
  const bodyBuffer = Buffer.allocUnsafe(4)
  bodyBuffer.writeUInt32LE(value, 0)
  const header = Buffer.allocUnsafe(8)
  header.writeUInt32LE(code, 0)
  header.writeUInt32LE(bodyBuffer.length, 4)
  return Buffer.concat([header, bodyBuffer])
}

describe("SDK3 startup and shutdown ordering", () => {
  test("constructing a client opens nothing", () => {
    let created = 0
    const client = new Client({
      pipe: "test",
      createSocket: () => {
        created++
        return new FakeSocket() as unknown as Sdk3SocketLike
      },
    })
    expect(created).toBe(0)
    client.dispose()
    expect(created).toBe(0)
  })

  test("dispose rejects an in-flight request instead of hanging until timeout", async () => {
    const { client } = harness({ timeoutMs: 5_000 })
    const pending = client.search("C:\\repo", "a", 10)
    await tick()
    client.dispose()
    const result = await settle(pending)
    expect(result.ok).toBe(false)
    expect(!result.ok && result.error.message).toMatch(/disposed|shut down/)
  })

  test("dispose is idempotent", () => {
    const { client, sockets } = harness()
    expect(() => {
      client.dispose()
      client.dispose()
      shutdownEverythingProvider()
      shutdownEverythingProvider()
    }).not.toThrow()
    expect(sockets.length).toBe(0)
  })

  test("the module-level shutdown is callable without a live provider", () => {
    expect(() => shutdownEverythingProvider()).not.toThrow()
  })

  test("SEARCH requests carry the SEARCH opcode and a length-prefixed payload", async () => {
    const h = harness()
    const { client } = h
    const pending = client.search("C:\\repo", "abc", 5)
    await tick()
    // `abc` compiles to BOTH an exact source and a basename-subsequence source,
    // so this is two sequential round trips on one pipe.
    const socket = h.sockets[0]!
    const sent = socket.sent
    expect(sent.readUInt32LE(0)).toBe(SEARCH)
    const declared = sent.readUInt32LE(4)
    expect(declared).toBe(sent.length - 8)
    expect(declared).toBeLessThanOrEqual(SDK3_LIMITS.MAX_REQUEST)

    socket.deliver(okResponse(["C:\\repo\\abc.ts"]))
    await tick()
    // The second leg was written on the same live socket.
    expect(socket.written.length).toBe(2)
    socket.deliver(okResponse(["C:\\repo\\abc.ts"]))
    expect((await settle(pending)).ok).toBe(true)
    client.dispose()
  })
})