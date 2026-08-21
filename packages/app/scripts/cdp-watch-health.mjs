// Long-running watcher: tails console (perf/health-relevant lines) AND Network domain
// request/response timing for the health-check endpoints, looking for the red-dot event
// live without needing to restart the app.
const DURATION_MS = Number(process.argv[2] ?? 300000)
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
  function send(method, params = {}) {
    const id = nextId++
    ws.send(JSON.stringify({ id, method, params }))
  }

  const start = Date.now()
  const inflight = new Map()
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    const t = () => ((Date.now() - start) / 1000).toFixed(2)
    if (msg.method === "Runtime.consoleAPICalled") {
      const text = msg.params.args.map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type))).join(" ")
      if (/health|status|disconnect|reconnect|stream|error|fail/i.test(text)) console.log(`[+${t()}s][console] ${text}`)
      return
    }
    if (msg.method === "Network.requestWillBeSent") {
      const url = msg.params.request.url
      if (/health/i.test(url)) inflight.set(msg.params.requestId, { url, start: Date.now() })
      return
    }
    if (msg.method === "Network.loadingFinished") {
      const req = inflight.get(msg.params.requestId)
      if (req) {
        const dur = Date.now() - req.start
        console.log(`[+${t()}s][net] OK ${dur}ms ${req.url}`)
        inflight.delete(msg.params.requestId)
      }
      return
    }
    if (msg.method === "Network.loadingFailed") {
      const req = inflight.get(msg.params.requestId)
      if (req) {
        const dur = Date.now() - req.start
        console.log(`[+${t()}s][net] FAILED ${dur}ms ${req.url} :: ${msg.params.errorText}`)
        inflight.delete(msg.params.requestId)
      }
      return
    }
  })

  send("Runtime.enable")
  send("Network.enable")
  console.error(`[cdp-watch-health] watching for ${DURATION_MS}ms`)
  await new Promise((r) => setTimeout(r, DURATION_MS))
  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
