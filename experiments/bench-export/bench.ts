// Benchmark: session export pipeline variants (v2)
// Run: bun bench-export/bench.ts
import { constants, brotliCompress, brotliCompressSync, brotliDecompressSync } from "node:zlib"
import { promisify } from "node:util"
const brotliAsync = promisify(brotliCompress) as (data: Buffer | string, opts?: object) => Promise<Buffer>

function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  "the quick brown fox refactor session export function returns value component render state effect layer service" +
  " database query message part token model provider cache stream worker memory latency throughput buffer promise" +
  " async await type schema validate encode decode compress frame segment delta crc magic header payload"
).split(" ")

function sentence(rand: () => number, words: number) {
  const out: string[] = []
  for (let i = 0; i < words; i++) out.push(WORDS[Math.floor(rand() * WORDS.length)])
  return out.join(" ")
}

function textBlock(rand: () => number, targetChars: number) {
  const parts: string[] = []
  let len = 0
  while (len < targetChars) {
    const s = sentence(rand, 8 + Math.floor(rand() * 12))
    parts.push(s)
    len += s.length + 1
  }
  return parts.join("\n")
}

const CODE_SNIPPET = `export function handle(req: Request): Response {
  const url = new URL(req.url)
  if (url.pathname === "/health") return new Response("ok")
  const body = req.body ? JSON.parse(await req.text()) : {}
  return Response.json({ ok: true, path: url.pathname, body })
}`

function toolOutput(rand: () => number): { title: string; output: string } {
  const kind = rand()
  if (kind < 0.38) return { title: "Read file", output: textBlock(rand, 800 + Math.floor(rand() * 4000)) }
  if (kind < 0.72) return { title: "bash", output: textBlock(rand, 500 + Math.floor(rand() * 12000)) }
  if (kind < 0.97)
    return {
      title: "edit",
      output: `${CODE_SNIPPET}\n${textBlock(rand, 300 + Math.floor(rand() * 2500))}`,
    }
  // ~3%: base64-ish blob (screenshots embedded in real sessions)
  const n = 64 * 1024 + Math.floor(rand() * 96 * 1024)
  const bytes = new Uint8Array(n)
  for (let i = 0; i < n; i++) bytes[i] = Math.floor(rand() * 256)
  return { title: "screenshot", output: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}` }
}

type Part = Record<string, unknown>

function makeParts(rand: () => number, msgID: string, role: "user" | "assistant"): Part[] {
  const parts: Part[] = []
  const id = (n: number) => `prt_${msgID}_${n}`
  let n = 0
  if (role === "user") {
    parts.push({ id: id(n++), type: "text", text: sentence(rand, 15 + Math.floor(rand() * 60)), time: Date.now() })
    if (rand() < 0.3)
      parts.push({
        id: id(n++),
        type: "file",
        mime: "text/plain",
        url: `file:///workspace/src/module${Math.floor(rand() * 50)}.ts`,
        filename: `module${Math.floor(rand() * 50)}.ts`,
      })
    return parts
  }
  if (rand() < 0.8)
    parts.push({ id: id(n++), type: "reasoning", text: textBlock(rand, 600 + Math.floor(rand() * 6000)) })
  const tools = Math.floor(rand() * 4)
  for (let t = 0; t < tools; t++) {
    const out = toolOutput(rand)
    parts.push({
      id: id(n++),
      type: "tool",
      callID: `call_${msgID}_${t}`,
      tool: ["read", "bash", "edit", "glob"][Math.floor(rand() * 4)],
      state: {
        status: "completed",
        input: { path: `/workspace/src/${sentence(rand, 2).replace(/ /g, "_")}.ts` },
        output: out.output,
        title: out.title,
        metadata: { precision: rand(), rows: Math.floor(rand() * 500), exit: 0 },
        time: { start: Date.now(), end: Date.now() + 100 },
      },
    })
  }
  parts.push({
    id: id(n++),
    type: "text",
    text: textBlock(rand, 400 + Math.floor(rand() * 3500)),
    metadata: { model: "stealth/ox-alpha", tokens: { input: Math.floor(rand() * 90000) } },
  })
  return parts
}

function makeSessionExport(messageCount: number, seed: number) {
  const rand = mulberry32(seed)
  const messages = []
  for (let i = 0; i < messageCount; i++) {
    const role = i % 3 === 2 ? "assistant" : "user"
    const msgID = `msg_${seed}_${i}`
    messages.push({
      info: {
        id: msgID,
        sessionID: `ses_${seed}`,
        role,
        agent: role === "user" ? "build" : undefined,
        modelID: role === "assistant" ? "ox-alpha" : undefined,
        providerID: role === "assistant" ? "openrouter" : undefined,
        time: { created: Date.now() + i, completed: Date.now() + i + 5000 },
        tokens: { input: Math.floor(rand() * 100000), output: Math.floor(rand() * 20000) },
        cost: rand() * 0.5,
        path: { cwd: "/workspace/project", root: "/workspace" },
      },
      parts: makeParts(rand, msgID, role),
    })
  }
  return {
    info: {
      id: `ses_${seed}`,
      title: `Benchmark session ${seed}`,
      slug: `benchmark-session-${seed}`,
      directory: "/workspace/project",
      version: "1.18.21",
      time: { created: Date.now(), updated: Date.now() },
    },
    messages,
  }
}

function medianSync(fn: () => unknown, runs: number) {
  const times: number[] = []
  let last: unknown
  for (let i = 0; i < runs; i++) {
    globalThis.gc?.()
    const t0 = performance.now()
    last = fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { ms: times[Math.floor(runs / 2)], result: last }
}

async function medianAsync(fn: () => Promise<unknown>, runs: number) {
  const times: number[] = []
  let last: unknown
  for (let i = 0; i < runs; i++) {
    globalThis.gc?.()
    const t0 = performance.now()
    last = await fn()
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  return { ms: times[Math.floor(runs / 2)], result: last }
}

const brParams = (q: number) => ({
  params: {
    [constants.BROTLI_PARAM_QUALITY]: q,
    [constants.BROTLI_PARAM_SIZE_HINT]: 0,
  },
})

async function main() {
  const scales = [
    { name: "small", msgs: 20, seed: 11, runs: 5 },
    { name: "medium", msgs: 300, seed: 22, runs: 5 },
    { name: "large", msgs: 1500, seed: 33, runs: 3 },
    { name: "xl", msgs: 8000, seed: 44, runs: 1 },
  ]
  console.log(`node ${process.version}, bun ${Bun.version}\n`)
  const summary: string[] = []

  // sanity: async (libuv threadpool) brotli accepts string input with params
  const sanityInput = "hello world ".repeat(1000)
  const sanity = await brotliAsync(sanityInput, brParams(4))
  const sanityOk = brotliDecompressSync(sanity).toString() === sanityInput
  console.log(`async-brotli string-input roundtrip: ${sanityOk ? "OK" : "FAIL"}\n`)

  for (const s of scales) {
    const data = makeSessionExport(s.msgs, s.seed)
    const runs = s.runs
    console.log(`== ${s.name}: ${s.msgs} messages ==`)
    const pretty = medianSync(() => JSON.stringify(data, null, 2), runs) as { ms: number; result: string }
    const compact = medianSync(() => JSON.stringify(data), runs) as { ms: number; result: string }
    const prettyBlob = medianSync(() => new Blob([pretty.result]), runs).ms
    const compactBlob = medianSync(() => new Blob([compact.result]), runs).ms
    const cloneObj = medianSync(() => structuredClone(data), runs).ms
    const strToBuf = medianSync(() => Buffer.from(compact.result, "utf8"), runs).ms

    const rawCompact = Buffer.from(compact.result, "utf8")
    const mb = (b: number) => (b / 1048576).toFixed(2)
    console.log(
      `pretty : ${pretty.ms.toFixed(0)}ms  ${mb(pretty.result.length * 2)}MB-utf16  blob=${prettyBlob.toFixed(1)}ms`,
    )
    console.log(
      `compact: ${compact.ms.toFixed(0)}ms  ${mb(rawCompact.byteLength)}MB       blob=${compactBlob.toFixed(1)}ms`,
    )
    console.log(`clone(object)=${cloneObj.toFixed(0)}ms  buf-from-string=${strToBuf.toFixed(0)}ms`)

    const brRows: string[] = []
    for (const q of [1, 2, 4, 6]) {
      const r = medianSync(
        () => brotliCompressSync(rawCompact, brParams(q)),
        q >= 4 && s.name === "xl" ? 1 : q >= 4 ? 2 : runs,
      ) as { ms: number; result: Buffer }
      const ok = brotliDecompressSync(r.result).equals(rawCompact)
      brRows.push(`q${q}: ${r.ms.toFixed(0)}ms ${mb(r.result.byteLength)}MB (${(rawCompact.byteLength / r.result.byteLength).toFixed(1)}x)${ok ? "" : " FAIL"}`)
    }
    // async variant at q2 (the likely production choice for big payloads)
    const asyncQ2 = (await medianAsync(async () => await brotliAsync(rawCompact, brParams(2)), 1)).ms
    brRows.push(`asyncQ2: ${asyncQ2.toFixed(0)}ms`)
    console.log(`brotli: ${brRows.join(" | ")}`)

    summary.push(
      `| ${s.name} | ${mb(pretty.result.length * 2)} | ${pretty.ms.toFixed(0)} + ${prettyBlob.toFixed(0)} | ${compact.ms.toFixed(0)} + ${compactBlob.toFixed(0)} | ${(compact.ms + strToBuf).toFixed(0)} (renderer) |`,
    )
    console.log("")
  }

  console.log("### Renderer-blocking comparison (ms)\n")
  console.log("| scale | today: pretty+blob | new-web: compact+blob | new-desktop: compact+send |")
  console.log("|---|---|---|---|")
  console.log(summary.join(""))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
