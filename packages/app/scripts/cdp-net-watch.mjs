const HOST = "127.0.0.1"
const PORT = 9222
const DURATION_MS = Number(process.argv[2] ?? 10000)

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

  const requests = new Map()
  const start = Date.now()
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    const t = () => ((Date.now() - start) / 1000).toFixed(2)
    if (msg.method === "Network.requestWillBeSent") {
      requests.set(msg.params.requestId, { url: msg.params.request.url, method: msg.params.request.method, at: t() })
    }
    if (msg.method === "Network.responseReceived") {
      const r = requests.get(msg.params.requestId)
      if (r) console.log(`[+${t()}s] RESPONSE ${msg.params.response.status} ${r.method} ${r.url}`)
    }
    if (msg.method === "Network.loadingFailed") {
      const r = requests.get(msg.params.requestId)
      console.log(`[+${t()}s] FAILED ${msg.params.errorText} ${r?.method ?? "?"} ${r?.url ?? msg.params.requestId}`)
      requests.delete(msg.params.requestId)
    }
    if (msg.method === "Network.loadingFinished") {
      requests.delete(msg.params.requestId)
    }
  })

  await send("Network.enable")
  console.error(`[cdp-net-watch] watching network for ${DURATION_MS}ms`)
  await new Promise((r) => setTimeout(r, DURATION_MS))

  console.log("--- still pending (no response/failure yet) ---")
  for (const [id, r] of requests) {
    console.log(`PENDING since +${r.at}s: ${r.method} ${r.url}`)
  }

  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
