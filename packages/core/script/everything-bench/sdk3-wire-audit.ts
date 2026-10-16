/**
 * SDK3 wire audit — STAGE 1: RAW CAPTURE (diagnostic-only; NOT a production path).
 *
 * Connects to the live isolated Everything instance pipe and records the RAW
 * bytes Everything actually puts on the wire for IS_DB_LOADED and SEARCH, then
 * walks those bytes with the SAME structural assumptions the production decoder
 * in `packages/core/src/search/everything.ts` makes. The point is to turn the
 * decoder's assumptions into evidence (or to prove them wrong).
 *
 * This script deliberately shares NO code with the production decoder so that
 * agreement between them is corroboration rather than a shared bug.
 *
 * Run:  bun packages/core/script/everything-bench/sdk3-wire-audit.ts
 *       node packages/core/script/everything-bench/sdk3-wire-audit.ts
 *
 * Diagnostic only: no es.exe, no native helper, no SDK3 shared library.
 * Named `*.ts` (not `*.test.ts`) so `bun test` never collects it.
 */
import net from "node:net"

// --- wire constants (independent re-derivation from observed bytes) ---
const PIPE = "\\\\.\\pipe\\Everything IPC (OpenFork-SDK3)"
const SEARCH = 7
const IS_DB_LOADED = 8
const RESPONSE_MORE = 100
const RESPONSE_OK = 200
const TIMEOUT_MS = 5000
const QUIET_MS = 400
const MAX_FRAME = 64 * 1024 * 1024

function hex(buf: Buffer, max = 256): string {
  const slice = buf.subarray(0, max)
  const rows: string[] = []
  for (let off = 0; off < slice.length; off += 16) {
    const chunk = slice.subarray(off, off + 16)
    const hx = [...chunk].map((b) => b.toString(16).padStart(2, "0")).join(" ")
    const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("")
    rows.push(`${off.toString(16).padStart(4, "0")}  ${hx.padEnd(47, " ")}  ${ascii}`)
  }
  if (buf.length > max) rows.push(`... ${buf.length - max} more bytes (total ${buf.length})`)
  return rows.join("\n")
}

type Frame = { code: number; size: number; body: Buffer }

function exchange(payload: Buffer, label: string): Promise<{ frames: Frame[]; leftover: Buffer }> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(PIPE)
    let settled = false
    let quietTimer: ReturnType<typeof setTimeout> | undefined
    const frames: Frame[] = []
    let rx = Buffer.alloc(0)

    const finish = (leftover: Buffer) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (quietTimer) clearTimeout(quietTimer)
      socket.destroy()
      resolve({ frames, leftover })
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (quietTimer) clearTimeout(quietTimer)
      socket.destroy()
      reject(new Error(`${label}: ${message}`))
    }
    const timer = setTimeout(() => fail(`timeout after ${TIMEOUT_MS}ms`), TIMEOUT_MS)

    socket.on("error", (e) => fail(`socket error: ${String(e)}`))
    socket.on("connect", () => {
      socket.write(payload, (e) => {
        if (e) fail(`write error: ${String(e)}`)
      })
    })
    socket.on("close", () => {
      // Server closed: everything it sent is what we have.
      finish(rx)
    })
    socket.on("data", (chunk: Buffer) => {
      rx = Buffer.concat([rx, chunk])
      while (rx.length >= 8) {
        const code = rx.readUInt32LE(0)
        const size = rx.readUInt32LE(4)
        if (size > MAX_FRAME) {
          fail(`absurd frame size ${size} declared`)
          return
        }
        if (rx.length < 8 + size) return
        frames.push({ code, size, body: rx.subarray(8, 8 + size) })
        rx = rx.subarray(8 + size)
      }
      // Wait for a quiet window instead of assuming: this is what REVEALS
      // whether the server sends anything after the terminal frame.
      if (quietTimer) clearTimeout(quietTimer)
      quietTimer = setTimeout(() => finish(rx), QUIET_MS)
    })
  })
}

function vlqEncode(value: number): Buffer {
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

function readVlq(body: Buffer, cursor: { offset: number }): number {
  const b0 = body[cursor.offset++]!
  if (b0 < 0xff) return b0
  const w = body.readUInt16LE(cursor.offset)
  cursor.offset += 2
  if (w < 0xffff) return 0xff + w
  const d = body.readUInt32LE(cursor.offset)
  cursor.offset += 4
  if (d < 0xffffffff) return 0xff + 0xffff + d
  throw new Error("oversized VLQ")
}

function buildSearch(root: string, query: string, count: number): Buffer {
  const FLAG_64BIT = 0x00004000
  const MATCH_PATH = 0x00000004
  const PROPERTY_PATH_AND_NAME = 240
  const text = `ancestor:"${root.replaceAll('"', '""')}" ${query}`.trim()
  const q = Buffer.from(text, "utf8")
  const flags = Buffer.allocUnsafe(4)
  flags.writeUInt32LE(FLAG_64BIT | MATCH_PATH, 0)
  const viewport = Buffer.allocUnsafe(16)
  viewport.writeBigUInt64LE(0n, 0)
  viewport.writeBigUInt64LE(BigInt(count), 8)
  const prop = Buffer.allocUnsafe(8)
  prop.writeUInt32LE(PROPERTY_PATH_AND_NAME, 0)
  prop.writeUInt32LE(0, 4)
  const payload = Buffer.concat([
    flags,
    vlqEncode(q.length),
    q,
    viewport,
    vlqEncode(0), // sorts
    vlqEncode(1), // one requested property
    prop,
  ])
  const header = Buffer.allocUnsafe(8)
  header.writeUInt32LE(SEARCH, 0)
  header.writeUInt32LE(payload.length, 4)
  return Buffer.concat([header, payload])
}

function walk(body: Buffer) {
  const FLAG_64BIT = 0x00004000
  const c = { offset: 0 }
  const u32 = () => {
    const v = body.readUInt32LE(c.offset)
    c.offset += 4
    return v
  }
  const report: Record<string, unknown> = {}
  if (body.length < 4) return { error: "body shorter than the flags u32" }
  const respFlags = u32()
  const wide = Boolean(respFlags & FLAG_64BIT)
  report.flags = `0x${respFlags.toString(16)}`
  report.wide = wide
  const readSize = (): number | string => {
    if (!wide) return u32()
    const v = body.readBigUInt64LE(c.offset)
    c.offset += 8
    return v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : `BIGINT(${v})`
  }
  report.folders = readSize()
  report.files = readSize()
  report.viewportOffset = readSize()
  report.viewportCount = readSize()
  if (c.offset > body.length) return { ...report, error: "truncated in size fields" }

  const sorts = readVlq(body, c)
  report.sorts = sorts
  const sortBytes = sorts * 8
  if (c.offset + sortBytes > body.length) {
    return { ...report, error: `sorts need ${sortBytes} bytes but only ${body.length - c.offset} remain` }
  }
  c.offset += sortBytes

  const props = readVlq(body, c)
  report.props = props
  if (props !== 1) return { ...report, error: `props=${props}, production expects exactly 1` }
  if (c.offset + 9 > body.length) return { ...report, error: "truncated before property descriptor" }
  const propId = body.readUInt32LE(c.offset)
  const propFlags = body.readUInt32LE(c.offset + 4)
  const propType = body[c.offset + 8]!
  c.offset += 9
  report.property = { id: propId, flags: propFlags, type: propType }

  const items: Array<{ flags: number; len: number; text: string }> = []
  const viewportCount = typeof report.viewportCount === "number" ? report.viewportCount : 0
  while (c.offset < body.length && items.length < Math.min(viewportCount, 4)) {
    const itemFlags = body[c.offset++]!
    const len = readVlq(body, c)
    if (c.offset + len > body.length) {
      report.error = `item[${items.length}] claims ${len} bytes but only ${body.length - c.offset} remain`
      break
    }
    items.push({
      flags: itemFlags,
      len,
      text: body.toString("utf8", c.offset, c.offset + Math.min(len, 200)),
    })
    c.offset += len
  }
  report.sampleItems = items
  report.finalOffset = c.offset
  report.bodyLength = body.length
  report.consumedExactly = c.offset === body.length
  report.trailingBytes = body.length - c.offset
  return report
}

async function main() {
  const root = process.argv[2] ?? "C:\\Users\\slooshied\\WebstormProjects\\opencode"
  const count = Number(process.argv[3] ?? 50)
  console.log(`pipe       : ${PIPE}`)
  console.log(`runtime    : bun=${(process as { isBun?: boolean }).isBun ? "yes" : "no"} node=${process.version} platform=${process.platform}`)
  console.log(`root/count : ${root} / ${count}`)

  const dbHeader = Buffer.allocUnsafe(8)
  dbHeader.writeUInt32LE(IS_DB_LOADED, 0)
  dbHeader.writeUInt32LE(0, 4)
  console.log("\n=== [1] REQUEST IS_DB_LOADED ===")
  console.log(hex(dbHeader))
  const db = await exchange(dbHeader, "IS_DB_LOADED")
  console.log(`frames=${db.frames.length} leftover=${db.leftover.length}`)
  for (const [i, f] of db.frames.entries()) {
    console.log(`frame[${i}] code=${f.code} size=${f.size}`)
    console.log(hex(f.body))
    if (f.body.length === 4) console.log(`  as u32le = ${f.body.readUInt32LE(0)}`)
    if (f.body.length === 1) console.log(`  as u8   = ${f.body[0]}`)
  }

  const request = buildSearch(root, "*search*", count)
  console.log("\n=== [2] REQUEST SEARCH ===")
  console.log(hex(request, 400))
  const sr = await exchange(request, "SEARCH")
  console.log(`frames=${sr.frames.length} leftover=${sr.leftover.length}`)
  let total = 0
  for (const [i, f] of sr.frames.entries()) {
    total += f.body.length
    const tag = f.code === RESPONSE_OK ? "RESPONSE_OK" : f.code === RESPONSE_MORE ? "RESPONSE_MORE" : "OTHER"
    console.log(`frame[${i}] code=${f.code} (${tag}) size=${f.size}`)
    console.log(hex(f.body, 160))
  }
  console.log(`total body bytes = ${total}`)
  if (sr.leftover.length > 0) {
    console.log(`LEFTOVER after terminal frame (${sr.leftover.length} bytes):`)
    console.log(hex(sr.leftover, 128))
  }

  const body = Buffer.concat(sr.frames.map((f) => f.body), total)
  console.log("\n=== [3] FIELD WALK (production structural assumptions) ===")
  console.log(JSON.stringify(walk(body), null, 2))

  console.log("\n=== [4] PAGING PROBE: request a viewport that forces RESPONSE_MORE ===")
  for (const n of [1, 10, 100, 1000, 5000]) {
    const r = buildSearch(root, "*search*", n)
    const out = await exchange(r, `SEARCH n=${n}`)
    const totalN = out.frames.reduce((sum, f) => sum + f.body.length, 0)
    const codes = out.frames.map((f) => f.code).join(",")
    console.log(`count=${n} frames=${out.frames.length} codes=[${codes}] totalBody=${totalN} leftover=${out.leftover.length}`)
  }

  console.log("\n=== [5] PER-FRAME WALK: does each RESPONSE_MORE frame carry its own header? ===")
  for (const n of [1000, 5000]) {
    const r = buildSearch(root, "*search*", n)
    const out = await exchange(r, `SEARCH per-frame n=${n}`)
    console.log(`\n--- count=${n}: ${out.frames.length} frames ---`)
    out.frames.forEach((f, i) => {
      const w = walk(f.body) as Record<string, unknown>
      console.log(
        `frame[${i}] code=${f.code} bytes=${f.body.length} flags=${w.flags} folders=${w.folders} files=${w.files} ` +
          `viewportOffset=${w.viewportOffset} viewportCount=${w.viewportCount} sorts=${w.sorts} props=${w.props} ` +
          `consumedExactly=${w.consumedExactly} trailing=${w.trailingBytes} err=${w.error ?? "-"}`,
      )
    })
    // Production concatenation semantics: parse(concat(all bodies)).
    const joined = Buffer.concat(out.frames.map((f) => f.body), out.frames.reduce((s, f) => s + f.body.length, 0))
    const jw = walk(joined) as Record<string, unknown>
    console.log(
      `CONCATENATED-AS-ONE (what production parse() does): viewportCount=${jw.viewportCount} ` +
        `sampleItems=${Array.isArray(jw.sampleItems) ? jw.sampleItems.length : "?"} consumedExactly=${jw.consumedExactly} ` +
        `trailing=${jw.trailingBytes} err=${jw.error ?? "-"}`,
    )
  }

  console.log("\nAUDIT-STAGE-1-COMPLETE")
}

main().catch((e) => {
  console.error(`FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`)
  process.exit(1)
})