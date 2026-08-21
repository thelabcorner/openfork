// Tails the live dev renderer's console via CDP (no restart needed) so we can see the
// perf.ts [perf] / [perf-longtask] lines in real time without a GUI DevTools window.
const DURATION_MS = Number(process.argv[2] ?? 90000)
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
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data)
    if (msg.method === "Runtime.consoleAPICalled") {
      const t = ((Date.now() - start) / 1000).toFixed(2)
      const text = msg.params.args
        .map((a) => (a.value !== undefined ? a.value : (a.description ?? a.type)))
        .join(" ")
      console.log(`[+${t}s] ${text}`)
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const t = ((Date.now() - start) / 1000).toFixed(2)
      console.log(`[+${t}s] EXCEPTION`, JSON.stringify(msg.params.exceptionDetails))
    }
  })

  send("Runtime.enable")
  console.error(`[cdp-console] tailing console for ${DURATION_MS}ms`)
  await new Promise((r) => setTimeout(r, DURATION_MS))
  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
