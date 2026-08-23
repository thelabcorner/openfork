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
        out.hasApi = typeof window.api
        out.apiKeys = window.api ? Object.keys(window.api) : []
      } catch (e) { out.err1 = String(e) }
      try {
        if (window.api?.getServers) out.servers = await window.api.getServers()
      } catch (e) { out.err2 = String(e) }
      try {
        if (window.api?.getDefaultServerUrl) out.defaultUrl = await window.api.getDefaultServerUrl()
      } catch (e) { out.err3 = String(e) }
      return out
    })()
  `
  const r1 = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, timeout: 5000 })
  console.log(JSON.stringify(r1, null, 2))

  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
