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

  await send("Runtime.enable")

  const expr = `
    (async () => {
      const out = {}
      try {
        out.location = window.location.href
      } catch (e) { out.locationErr = String(e) }
      try {
        const perf = performance.getEntriesByType("resource").slice(-15).map(e => ({name: e.name, dur: Math.round(e.duration), start: Math.round(e.startTime)}))
        out.recentRequests = perf
      } catch (e) { out.perfErr = String(e) }
      try {
        out.pendingCount = performance.getEntriesByType("resource").filter(e => e.responseEnd === 0).length
      } catch (e) {}
      return out
    })()
  `
  const result = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })
  console.log(JSON.stringify(result.result, null, 2))

  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
