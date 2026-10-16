/**
 * SDK3 IPC Node/Bun PARITY GATE (diagnostic-only; not collected by `bun test`).
 *
 * Everything's candidate provider ships in both the Bun server and the Node
 * desktop sidecar, so the transport decoder must behave identically under both.
 * The IPC test suite runs under `bun test`, which is only half the claim. This
 * probe runs the SAME decoder/transport assertions under whichever runtime
 * executes it and prints a stable digest plus PASS/FAIL, so parity is a
 * reproducible command rather than an assertion:
 *
 *   bun  packages/core/script/everything-bench/sdk3-parity-probe.ts
 *   node packages/core/script/everything-bench/sdk3-parity-probe.ts
 *
 * Compare the two `DIGEST` lines. Any divergence is a real gate failure, not a
 * tolerance to widen.
 *
 * No live Everything instance is required: the socket is injected, so this
 * exercises framing, decoding, bounds, timeout, restart and shutdown on every
 * platform.
 */
import { Client, SDK3_LIMITS, parse, shutdownEverythingProvider } from "../../src/search/everything"

const FLAG_64BIT = 0x00004000
const PROPERTY_PATH_AND_NAME = 240
const RESPONSE_OK = 200

function vlq(value: number): Buffer {
  if (value < 0xff) return Buffer.from([value])
  let next = value - 0xff
  if (next < 0xffff) {
    const out = Buffer.allocUnsafe(3)
    out[0] = 0xff
    out.writeUInt16LE(next, 1)
    return out
  }
  next -= 0xffff
  const out = Buffer.allocUnsafe(7)
  out[0] = 0xff
  out.writeUInt16LE(0xffff, 1)
  out.writeUInt32LE(next, 3)
  return out
}

function makeBody(count: number, pathOf: (i: number) => string, wide = true): Buffer {
  const flags = Buffer.allocUnsafe(4)
  flags.writeUInt32LE(wide ? FLAG_64BIT : 0, 0)
  const sizes = Buffer.allocUnsafe(wide ? 32 : 16)
  if (wide) {
    sizes.writeBigUInt64LE(0n, 0)
    sizes.writeBigUInt64LE(BigInt(count), 8)
    sizes.writeBigUInt64LE(0n, 16)
    sizes.writeBigUInt64LE(BigInt(count), 24)
  } else {
    sizes.writeUInt32LE(0, 0)
    sizes.writeUInt32LE(count, 4)
    sizes.writeUInt32LE(0, 8)
    sizes.writeUInt32LE(count, 12)
  }
  const descriptor = Buffer.allocUnsafe(9)
  descriptor.writeUInt32LE(PROPERTY_PATH_AND_NAME, 0)
  descriptor.writeUInt32LE(0, 4)
  descriptor[8] = 15
  const parts: Buffer[] = [flags, sizes, vlq(0), vlq(1), descriptor]
  for (let i = 0; i < count; i++) {
    const bytes = Buffer.from(pathOf(i), "utf8")
    parts.push(Buffer.from([i % 2]), vlq(bytes.length), bytes)
  }
  return Buffer.concat(parts)
}

function frame(code: number, payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(8)
  header.writeUInt32LE(code, 0)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

const results: string[] = []
let failures = 0

function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  results.push(`${ok ? "PASS" : "FAIL"} ${name} => ${JSON.stringify(actual)}`)
}

function parseOutcome(input: Buffer): string {
  try {
    const decoded = parse(input)
    return `ok:${decoded.total}:${decoded.items.length}:${decoded.items[0]?.fullPath ?? "-"}`
  } catch (error) {
    return `throw:${error instanceof Error ? error.message : String(error)}`
  }
}

class FakeSocket {
  destroyed = false
  readonly written: Buffer[] = []
  private readonly listeners = new Map<string, Array<(...args: never[]) => void>>()
  write(data: Buffer, callback?: (error?: Error | null) => void) {
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
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((e) => e !== listener))
    return this
  }
  emit(event: string, ...args: never[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
  deliver(bytes: Buffer) {
    this.emit("data", bytes as never)
  }
  remoteClose() {
    this.destroyed = true
    this.emit("close" as never)
  }
}

function harness(timeoutMs: number) {
  const sockets: FakeSocket[] = []
  const client = new Client({
    pipe: "parity",
    timeoutMs,
    createSocket: () => {
      const socket = new FakeSocket()
      sockets.push(socket)
      queueMicrotask(() => socket.emit("connect" as never))
      return socket as never
    },
  })
  return { client, sockets }
}

async function tick() {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function outcome<T>(promise: Promise<T>): Promise<string> {
  try {
    return `ok:${JSON.stringify(await promise)}`
  } catch (error) {
    return `throw:${error instanceof Error ? error.message : String(error)}`
  }
}

/**
 * Pin only this lane's transport/decoder contract. `Client.search` also returns
 * keystream-lifecycle's completeness fields; normalizing them away keeps the
 * parity digest about IPC behavior instead of about another lane's shape.
 */
type SearchLike = {
  total: number
  viewportOffset: number
  items: Array<{ fullPath: string; isDir: boolean }>
}

function normalize(value: SearchLike) {
  return {
    total: value.total,
    viewportOffset: value.viewportOffset,
    count: value.items.length,
    first: value.items[0]?.fullPath ?? "-",
  }
}

async function searchOutcome(promise: Promise<SearchLike>): Promise<string> {
  try {
    return `ok:${JSON.stringify(normalize(await promise))}`
  } catch (error) {
    return `throw:${error instanceof Error ? error.message : String(error)}`
  }
}

async function main() {
  // ---- decoder ----
  check("decode.wide.3", parseOutcome(makeBody(3, (i) => `C:\\r\\${i}.ts`)), 'ok:3:3:C:\\r\\0.ts')
  check("decode.narrow.2", parseOutcome(makeBody(2, (i) => `C:\\r\\${i}.ts`, false)), 'ok:2:2:C:\\r\\0.ts')
  check("decode.empty", parseOutcome(makeBody(0, () => "")), "ok:0:0:-")

  const oversized = makeBody(0, () => "")
  oversized.writeBigUInt64LE(BigInt(SDK3_LIMITS.MAX_ITEMS) + 1n, 28)
  check("decode.bound.viewport", parseOutcome(oversized), "throw:SDK3 viewport exceeds item bound")

  const badOffset = makeBody(1, () => "a")
  badOffset.writeBigUInt64LE(7n, 20)
  check("decode.fail.offset", parseOutcome(badOffset), "throw:unexpected SDK3 viewport offset")

  const badProp = makeBody(1, () => "a")
  // flags(4)+sizes(32)=36, vlq(sorts)=1 -> 37, vlq(props)=1 -> 38, descriptor@38
  badProp.writeUInt32LE(9, 38)
  check("decode.fail.property", parseOutcome(badProp), "throw:unexpected path property")

  check("decode.fail.trailing", parseOutcome(Buffer.concat([makeBody(1, () => "a"), Buffer.from([1, 2])])), "throw:trailing SDK3 bytes")
  check("decode.fail.empty", parseOutcome(Buffer.alloc(0)), "throw:truncated response")
  check("decode.fail.short", parseOutcome(Buffer.from([1, 2])), "throw:truncated response")

  const bigSorts = makeBody(0, () => "")
  bigSorts[36] = 0x7f
  check("decode.fail.sorts", parseOutcome(bigSorts), "throw:SDK3 sort count exceeds bound")

  const hugeSize = makeBody(0, () => "")
  hugeSize.writeBigUInt64LE((1n << 63n) - 1n, 12)
  check("decode.fail.sizet", parseOutcome(hugeSize), "throw:SIZE_T too large")

  // ---- per-source drainability (the changed math), parity-gated ----
  // A 1-char query produces only the exact source, so the branch that changed
  // needs a 2-char query. Totals deliberately cross MAX_VIEWPORT when summed and
  // do not when maxed, which is the whole regression.
  {
    const h = harness(500)
    const make = (prefix: string, n: number, start = 0) =>
      Array.from({ length: n }, (_, i) => `C:\\small\\${prefix}${i + start}.ts`)
    const exact = makeBody(6000, (i) => `C:\\small\\e${i}.ts`)
    const broad = makeBody(5500, (i) =>
      i < 5000 ? `C:\\small\\e${i}.ts` : `C:\\small\\b${i + 95_000}.ts`,
    )
    const pending = h.client.search("C:\\small", "ab", SDK3_LIMITS.MAX_VIEWPORT)
    await tick()
    h.sockets[0]!.deliver(frame(RESPONSE_OK, exact))
    await tick()
    h.sockets[0]!.deliver(frame(RESPONSE_OK, broad))
    const value = (await pending) as unknown as {
      total: number
      exhaustible: boolean
      complete: boolean
      requiredCount: number
      basenameSubsequenceComplete: boolean
      items: Array<unknown>
    }
    check("drain.total", value.total, 6000)
    check("drain.requiredCount", value.requiredCount, 6000)
    check("drain.exhaustible", value.exhaustible, true)
    check("drain.complete", value.complete, true)
    check("drain.basenameComplete", value.basenameSubsequenceComplete, true)
    check("drain.unionSize", value.items.length, 6500)
    // The arithmetic that motivated the change, pinned per runtime.
    check("drain.sumWouldCross", 6000 + 5500 > SDK3_LIMITS.MAX_VIEWPORT, true)
    check("drain.maxDoesNot", Math.max(6000, 5500) <= SDK3_LIMITS.MAX_VIEWPORT, true)
    h.client.dispose()
  }

  // ---- transport: byte-at-a-time reassembly ----
  {
    const h = harness(500)
    const pending = h.client.search("C:\\r", "x", 10)
    await tick()
    const wire = frame(RESPONSE_OK, makeBody(2, (i) => `C:\\r\\b${i}.ts`))
    for (const byte of wire) h.sockets[0]!.deliver(Buffer.from([byte]))
    check("transport.byteAtATime", await searchOutcome(pending), 'ok:{"total":2,"viewportOffset":0,"count":2,"first":"C:\\\\r\\\\b0.ts"}')
    h.client.dispose()
  }

  // ---- transport: RESPONSE_MORE continuous stream ----
  {
    const h = harness(500)
    const pending = h.client.search("C:\\r", "x", 10)
    await tick()
    const whole = makeBody(4, (i) => `C:\\r\\m${i}.ts`)
    const c1 = Math.floor(whole.length / 2)
    h.sockets[0]!.deliver(
      Buffer.concat([
        frame(100, whole.subarray(0, c1)),
        frame(100, whole.subarray(c1)),
        frame(RESPONSE_OK, Buffer.alloc(0)),
      ]),
    )
    check("transport.moreFrames", (await outcome(pending)).includes('"total":4') ? "ok" : "bad", "ok")
    h.client.dispose()
  }

  // ---- transport: oversized frame header ----
  {
    const h = harness(500)
    const pending = h.client.search("C:\\r", "x", 10)
    await tick()
    const header = Buffer.allocUnsafe(8)
    header.writeUInt32LE(RESPONSE_OK, 0)
    header.writeUInt32LE(SDK3_LIMITS.MAX_FRAME + 1, 4)
    h.sockets[0]!.deliver(header)
    check("transport.frameTooLarge", await outcome(pending), "throw:SDK3 frame too large")
    check("transport.frameTooLarge.destroyed", h.sockets[0]!.destroyed, true)
    h.client.dispose()
  }

  // ---- transport: unknown code ----
  {
    const h = harness(500)
    const pending = h.client.search("C:\\r", "x", 10)
    await tick()
    h.sockets[0]!.deliver(frame(999, Buffer.from([1, 0, 0, 0])))
    check("transport.badCode", await outcome(pending), "throw:SDK3 response 999")
    h.client.dispose()
  }

  // ---- transport: timeout ----
  {
    const h = harness(40)
    check("transport.timeout", await outcome(h.client.search("C:\\r", "x", 10)), "throw:SDK3 timeout")
    h.client.dispose()
  }

  // ---- transport: restart mid-request, then recover ----
  {
    const h = harness(500)
    const first = h.client.search("C:\\r", "x", 10)
    await tick()
    h.sockets[0]!.deliver(frame(RESPONSE_OK, makeBody(1, () => "C:\\r\\before.ts")))
    check("transport.restart.first", await searchOutcome(first), 'ok:{"total":1,"viewportOffset":0,"count":1,"first":"C:\\\\r\\\\before.ts"}')

    const mid = h.client.search("C:\\r", "y", 10)
    await tick()
    h.sockets[0]!.remoteClose()
    check("transport.restart.mid", await outcome(mid), "throw:SDK3 pipe closed")

    const after = h.client.search("C:\\r", "z", 10)
    await tick()
    h.sockets[1]!.deliver(frame(RESPONSE_OK, makeBody(1, () => "C:\\r\\after.ts")))
    check("transport.restart.recover", await searchOutcome(after), 'ok:{"total":1,"viewportOffset":0,"count":1,"first":"C:\\\\r\\\\after.ts"}')
    check("transport.restart.socketCount", h.sockets.length, 2)
    h.client.dispose()
  }

  // ---- transport: readiness + TTL re-ask ----
  {
    const h = harness(500)
    const probe = h.client.ready()
    await tick()
    h.sockets[0]!.deliver(frame(RESPONSE_OK, Buffer.from([1, 0, 0, 0])))
    check("readiness.loaded", await outcome(probe), "ok:true")

    const writesBefore = h.sockets[0]!.written.length
    check("readiness.cachedInTtl", await outcome(h.client.ready()), "ok:true")
    check("readiness.noExtraWrite", h.sockets[0]!.written.length, writesBefore)

    const realNow = Date.now
    try {
      Date.now = () => realNow() + SDK3_LIMITS.READY_TTL_MS + 1000
      const recheck = h.client.ready()
      await tick()
      check("readiness.reaskedAfterTtl", h.sockets[0]!.written.length > writesBefore, true)
      h.sockets[0]!.deliver(frame(RESPONSE_OK, Buffer.from([1, 0, 0, 0])))
      await outcome(recheck)
    } finally {
      Date.now = realNow
    }
    h.client.dispose()
  }

  // ---- transport: readiness timeout clears the stale ready claim ----
  {
    const h = harness(40)
    check("readiness.timeout", await outcome(h.client.ready()), "throw:SDK3 readiness timeout")
    h.client.dispose()
  }

  // ---- startup / shutdown ordering ----
  {
    let created = 0
    const client = new Client({ pipe: "parity", createSocket: () => { created++; return new FakeSocket() as never } })
    check("startup.inert", created, 0)
    client.dispose()
    client.dispose()
    shutdownEverythingProvider()
    shutdownEverythingProvider()
    check("shutdown.idempotent", created, 0)
  }

  check("limits.stable", {
    maxFrame: SDK3_LIMITS.MAX_FRAME,
    maxResponse: SDK3_LIMITS.MAX_RESPONSE,
    maxItems: SDK3_LIMITS.MAX_ITEMS,
    maxSorts: SDK3_LIMITS.MAX_SORTS,
    readyTtlMs: SDK3_LIMITS.READY_TTL_MS,
  }, { maxFrame: 16777216, maxResponse: 67108864, maxItems: 10000, maxSorts: 16, readyTtlMs: 5000 })

  const runtime = (process as { isBun?: boolean }).isBun ? "bun" : "node"
  for (const line of results) console.log(line)
  console.log(`RUNTIME ${runtime} v${process.version}`)
  // Stable across runtimes: no timings, no memory, no object identity.
  const digestInput = results.join("\n")
  let hash = 0x811c9dc5
  for (let i = 0; i < digestInput.length; i++) {
    hash ^= digestInput.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  console.log(`DIGEST ${hash.toString(16).padStart(8, "0")}`)
  console.log(failures === 0 ? "PARITY-PROBE-PASS" : `PARITY-PROBE-FAIL ${failures}`)
  if (failures > 0) process.exitCode = 1
}

await main()