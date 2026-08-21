// Combines CPU profiling + console tailing on the same local wall-clock timeline so we
// can attribute a specific [perf-longtask] spike to the CPU-profile samples that
// occurred during it (not just aggregate self-time over the whole recording).
const DURATION_MS = Number(process.argv[2] ?? 60000)
const HOST = "127.0.0.1"
const PORT = 9222

async function main() {
  const list = await fetch(`http://${HOST}:${PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === "page" && t.title === "OpenCode")
  if (!page) throw new Error("OpenCode page target not found: " + JSON.stringify(list))

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const consoleLines = []
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type))).join(" ")
      consoleLines.push({ t: Date.now(), text })
    }
  })

  function send(method, params = {}) {
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  await send("Runtime.enable")
  await send("Profiler.enable")
  await send("Profiler.setSamplingInterval", { interval: 200 })
  await send("Profiler.start")
  const profileStartLocal = Date.now()
  console.error(`[cdp-combined] recording for ${DURATION_MS}ms`)
  await new Promise((r) => setTimeout(r, DURATION_MS))
  const stopped = await send("Profiler.stop")
  const profile = stopped.result.profile

  // Map each sample to a local wall-clock ms using cumulative timeDeltas from start.
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
  const samples = profile.samples ?? []
  const timeDeltas = profile.timeDeltas ?? []
  let cumUs = 0
  const timedSamples = []
  for (let i = 0; i < samples.length; i++) {
    cumUs += Math.max(timeDeltas[i] ?? 0, 0)
    timedSamples.push({ localMs: profileStartLocal + cumUs / 1000, nodeId: samples[i] })
  }

  const longtasks = consoleLines
    .filter((l) => l.text.startsWith("[perf-longtask]"))
    .map((l) => ({ ...l, ms: Number(l.text.match(/([\d.]+)ms/)?.[1] ?? 0) }))

  console.log(`\n=== ${longtasks.length} longtask spikes captured; ${timedSamples.length} CPU samples ===`)

  // Only attribute the biggest few to keep output short.
  const top = [...longtasks].sort((a, b) => b.ms - a.ms).slice(0, 6)
  for (const lt of top) {
    const windowStart = lt.t - lt.ms
    const windowEnd = lt.t
    const inWindow = timedSamples.filter((s) => s.localMs >= windowStart && s.localMs <= windowEnd)
    const bucket = new Map()
    for (const s of inWindow) {
      const n = nodeById.get(s.nodeId)
      const cf = n?.callFrame ?? {}
      const key = `${cf.functionName || "(anonymous)"} | ${cf.url || ""}:${cf.lineNumber}`
      bucket.set(key, (bucket.get(key) ?? 0) + 1)
    }
    const ranked = [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
    console.log(`\n--- longtask ${lt.ms}ms at local+${((lt.t - profileStartLocal) / 1000).toFixed(2)}s (${inWindow.length} samples in window) ---`)
    for (const [key, count] of ranked) console.log(`  ${count} samples\t${key}`)
  }

  const fs = await import("node:fs")
  fs.writeFileSync("cdp-combined-out.cpuprofile", JSON.stringify(profile))
  console.log("\nFull profile written to cdp-combined-out.cpuprofile")
  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
