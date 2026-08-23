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
        out.localStorageKeys = Object.keys(localStorage).filter(k => k.toLowerCase().includes("server") || k.toLowerCase().includes("url"))
      } catch (e) { out.lsErr = String(e) }
      try {
        const raw = localStorage.getItem("opencode.servers") || localStorage.getItem("servers")
        out.serversRaw = raw
      } catch (e) {}
      return out
    })()
  `
  const r1 = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })
  console.log("--- storage ---")
  console.log(JSON.stringify(r1.result, null, 2))

  const expr2 = `
    (async () => {
      const results = []
      try {
        const urls = window.__lastServerUrls || []
        results.push({urls})
      } catch (e) {}
      return results
    })()
  `
  const r2 = await send("Runtime.evaluate", { expression: expr2, awaitPromise: true, returnByValue: true })
  console.log("--- window hints ---")
  console.log(JSON.stringify(r2.result, null, 2))

  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
