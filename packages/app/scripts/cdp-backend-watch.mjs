// Attaches to the backend sidecar's Node inspector (127.0.0.1:9229, opened via the
// temporary execArgv in packages/desktop/src/main/server.ts) and:
//  - records a CPU profile for the whole window
//  - polls process.memoryUsage() / active handle+request counts every INTERVAL_MS
// to find what's growing during the progressive request-latency degradation.
const DURATION_MS = Number(process.argv[2] ?? 360000)
const INTERVAL_MS = Number(process.argv[3] ?? 15000)
const HOST = "127.0.0.1"
const PORT = 9229

async function main() {
  const list = await fetch(`http://${HOST}:${PORT}/json/list`).then((r) => r.json())
  const target = list.find((t) => t.type === "node")
  if (!target) throw new Error("Node inspector target not found: " + JSON.stringify(list))

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true })
    ws.addEventListener("error", reject, { once: true })
  })

  let nextId = 1
  const pending = new Map()
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
      return
    }
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type))).join(" ")
      console.log(`[backend console] ${text}`)
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
  await send("Profiler.setSamplingInterval", { interval: 500 })
  await send("Profiler.start")
  const start = Date.now()
  console.error(`[backend-watch] attached, recording for ${DURATION_MS}ms`)

  const metricsExpr = `
    JSON.stringify({
      mem: process.memoryUsage(),
      handles: process._getActiveHandles().length,
      requests: process._getActiveRequests().length,
      uptime: process.uptime(),
    })
  `
  const timer = setInterval(async () => {
    const t = ((Date.now() - start) / 1000).toFixed(1)
    const result = await send("Runtime.evaluate", { expression: metricsExpr, returnByValue: true })
    const value = result.result?.result?.value
    if (value) {
      const m = JSON.parse(value)
      console.log(
        `[+${t}s] rss=${(m.mem.rss / 1024 / 1024).toFixed(0)}MB heapUsed=${(m.mem.heapUsed / 1024 / 1024).toFixed(0)}MB heapTotal=${(m.mem.heapTotal / 1024 / 1024).toFixed(0)}MB external=${(m.mem.external / 1024 / 1024).toFixed(0)}MB arrayBuffers=${(m.mem.arrayBuffers / 1024 / 1024).toFixed(0)}MB handles=${m.handles} requests=${m.requests}`,
      )
    }
  }, INTERVAL_MS)

  await new Promise((r) => setTimeout(r, DURATION_MS))
  clearInterval(timer)

  const stopped = await send("Profiler.stop")
  const profile = stopped.result.profile
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
  const samples = profile.samples ?? []
  const bucket = new Map()
  for (const nodeId of samples) {
    const n = nodeById.get(nodeId)
    const cf = n?.callFrame ?? {}
    const key = `${cf.functionName || "(anonymous)"} | ${cf.url || ""}:${cf.lineNumber}`
    bucket.set(key, (bucket.get(key) ?? 0) + 1)
  }
  const total = samples.length
  const ranked = [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40)
  console.log(`\n=== ${total} backend CPU samples over ${DURATION_MS}ms ===`)
  for (const [key, count] of ranked) console.log(`${((count / total) * 100).toFixed(1)}%\t${count}\t${key}`)

  const fs = await import("node:fs")
  fs.writeFileSync("cdp-backend-profile.cpuprofile", JSON.stringify(profile))
  console.log("\nFull profile written to cdp-backend-profile.cpuprofile")
  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
