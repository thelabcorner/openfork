// One-off diagnostic script: attaches to the running dev Electron renderer via the
// Chrome DevTools Protocol (already listening on 127.0.0.1:9222 per AGENTS rule: never
// restart the app), records a CPU profile for DURATION_MS, and dumps aggregated self-time
// per function so we can find the periodic long-task source described in PERF-HANDOFF.md
// without needing a GUI DevTools session.
const DURATION_MS = Number(process.argv[2] ?? 30000)
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
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })

  function send(method, params = {}) {
    const id = nextId++
    return new Promise((resolve) => {
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  await send("Profiler.enable")
  await send("Profiler.setSamplingInterval", { interval: 200 }) // 200us, fine enough for >100ms tasks
  await send("Profiler.start")
  console.error(`[cdp-profile] recording for ${DURATION_MS}ms — interact with the app now if reproducing a spike`)
  await new Promise((r) => setTimeout(r, DURATION_MS))
  const stopped = await send("Profiler.stop")
  const profile = stopped.result.profile

  // Aggregate self time per node (functionName@url:line), independent of call tree shape.
  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
  const selfTimeUs = new Map()
  const timeDeltas = profile.timeDeltas ?? []
  const samples = profile.samples ?? []
  for (let i = 0; i < samples.length; i++) {
    const dt = timeDeltas[i] ?? 0
    const nodeId = samples[i]
    selfTimeUs.set(nodeId, (selfTimeUs.get(nodeId) ?? 0) + Math.max(dt, 0))
  }

  const rows = [...selfTimeUs.entries()]
    .map(([id, us]) => {
      const n = nodeById.get(id)
      const cf = n?.callFrame ?? {}
      return {
        ms: us / 1000,
        fn: cf.functionName || "(anonymous)",
        url: cf.url || "",
        line: cf.lineNumber,
      }
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 40)

  console.log("\n=== Top self-time functions over the recording window ===")
  for (const r of rows) {
    console.log(`${r.ms.toFixed(1)}ms\t${r.fn}\t${r.url}:${r.line}`)
  }

  const fs = await import("node:fs")
  fs.writeFileSync("cdp-profile-out.cpuprofile", JSON.stringify(profile))
  console.log("\nFull profile written to cdp-profile-out.cpuprofile")

  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
