// Extract context windows around high-signal keywords from the WorkBuddy app bundle.
// Goal: find the real model-discovery endpoint and the Hy4 model identifier.
import { openSync, readSync, closeSync, fstatSync } from "node:fs"

const path = process.argv[2]
const KEYWORDS = process.argv.slice(3)
const CTX = 260

const fd = openSync(path, "r")
const size = fstatSync(fd).size
const CHUNK = 8 * 1024 * 1024
const OVERLAP = 8192

const hits = new Map() // keyword -> Set(context)
for (const k of KEYWORDS) hits.set(k, new Set())

let carry = Buffer.alloc(0)
let offset = 0
while (offset < size) {
  const len = Math.min(CHUNK, size - offset)
  const buf = Buffer.alloc(len)
  readSync(fd, buf, 0, len, offset)
  const text = Buffer.concat([carry, buf]).toString("latin1")
  for (const k of KEYWORDS) {
    let i = text.indexOf(k)
    while (i !== -1) {
      const s = Math.max(0, i - CTX)
      const e = Math.min(text.length, i + k.length + CTX)
      let ctx = text.slice(s, e).replace(/[^\x20-\x7e]/g, " ")
      ctx = ctx.replace(/[A-Za-z0-9_\-]{32,}/g, "<REDACTED>")
      if (hits.get(k).size < 25) hits.get(k).add(ctx)
      i = text.indexOf(k, i + 1)
    }
  }
  carry = buf.subarray(Math.max(0, len - OVERLAP))
  offset += len
}
closeSync(fd)

for (const [k, set] of hits) {
  console.log(`\n${"=".repeat(78)}\nKEYWORD: ${k}   (${set.size} contexts)\n${"=".repeat(78)}`)
  let n = 0
  for (const c of set) console.log(`\n--- [${++n}] ---\n${c}`)
}
