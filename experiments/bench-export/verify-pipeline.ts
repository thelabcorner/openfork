// Verifies the exact production export pipeline end-to-end:
// stringify -> IPC-string handoff -> promisified brotli (q5 <1MiB else q2, SIZE_HINT) -> decompress -> JSON.parse
// Run: bun bench-export/verify-pipeline.ts
import { constants, brotliDecompressSync } from "node:zlib"
import { brotliCompress } from "node:zlib"
import { promisify } from "node:util"
const brotliCompressAsync = promisify(brotliCompress)

function makeSessionExport(messageCount: number, seed: number) {
  const rand = (() => {
    let s = seed | 0
    return () => {
      s = (s + 0x6d2b79f5) | 0
      let t = Math.imul(s ^ (s >>> 15), 1 | s)
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  })()
  const messages = []
  for (let i = 0; i < messageCount; i++) {
    const words: string[] = []
    for (let w = 0; w < 200; w++) words.push(`token${Math.floor(rand() * 5000)}`)
    messages.push({
      info: { id: `msg_${i}`, role: i % 2 ? "user" : "assistant" },
      parts: [{ id: `prt_${i}`, type: "text", text: words.join(" ") }],
    })
  }
  return {
    info: { id: `ses_${seed}`, title: "verify" },
    messages,
  }
}

async function compressExport(json: string): Promise<Buffer> {
  const rawBytes = Buffer.byteLength(json, "utf8")
  const quality = rawBytes < 1024 * 1024 ? 5 : 2
  return brotliCompressAsync(json, {
    params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: rawBytes },
  })
}

async function main() {
  let failures = 0
  for (const msgs of [1, 50, 300, 2500]) {
    const data = makeSessionExport(msgs, 1000 + msgs)
    const json = JSON.stringify(data)
    const raw = Buffer.byteLength(json, "utf8")
    const t0 = performance.now()
    const compressed = await compressExport(json)
    const compressMs = performance.now() - t0
    const restored = JSON.parse(brotliDecompressSync(compressed).toString("utf8"))
    const ok = JSON.stringify(restored) === json
    if (!ok) failures++
    console.log(
      `${ok ? "OK " : "FAIL"} msgs=${String(msgs).padStart(4)}  raw=${(raw / 1048576).toFixed(2)}MB  br=${(compressed.byteLength / 1048576).toFixed(2)}MB (${(raw / compressed.byteLength).toFixed(1)}x)  q=${raw < 1048576 ? 5 : 2}  compress=${compressMs.toFixed(0)}ms`,
    )
  }
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
