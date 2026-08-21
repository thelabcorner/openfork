import { Database } from "bun:sqlite"
import fs from "fs"
import os from "os"
import path from "path"
import { Context, Effect, Layer } from "effect"
import { ChunkStore } from "./src/search/chunk-store"
import { compareBytes, frontDecode } from "./src/search/front-code"

const REAL = "C:/Users/slooshied/.local/share/opencode/file-index/8477d838d1cb4e5e8a46e82e4b93ce516286fcf81e3a34bdc6a8ed61cad42577.json"
const doc = JSON.parse(fs.readFileSync(REAL, "utf8"))
const corpus: string[] = []
for (const tree of Object.values<any>(doc.subtrees)) for (const e of tree.entries) corpus.push(e.path)
const sorted = corpus.map((p) => new TextEncoder().encode(p)).sort(compareBytes)
const nonAscii = sorted.filter((e) => e.some((b) => b > 0x7f))
console.log("total", sorted.length, "nonAscii", nonAscii.length)
console.log("first nonAscii index:", sorted.findIndex((e) => e.some((b) => b > 0x7f)))
console.log("sample nonAscii:", nonAscii.slice(0, 3).map((e) => new TextDecoder().decode(e)))

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbg-"))
await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(ChunkStore.layerFromPath(path.join(dir, "i.db")))
      const store = Context.get(ctx as any, ChunkStore.Service)
      const chunks: any[] = []
      for (let i = 0; i < sorted.length; i += 8192) chunks.push({ kind: 0, entries: sorted.slice(i, i + 8192) })
      yield* store.append(chunks)
      const raw = yield* store.readRaw(0)
      console.log("chunks:", raw.length)
      for (let ci = 0; ci < Math.min(3, raw.length); ci++) {
        const c = raw[ci]
        const hasHigh = c.body.some((b: number) => b > 0x7f)
        console.log(`chunk${ci} count=${c.count} bodyLen=${c.body.length} hasHigh=${hasHigh}`)
        try {
          const t0 = performance.now()
          const strings = frontDecode(c.body, c.count)
          console.log(`  decoded ok ${strings.length} in ${(performance.now() - t0).toFixed(1)}ms; first="${strings[0]}" last="${strings[strings.length - 1]}"`)
        } catch (e) {
          console.log("  DECODE FAIL:", String(e))
        }
      }
    }),
  ) as any,
)
fs.rmSync(dir, { recursive: true, force: true })
