// Triggers a real tab-switch click on the live dev app via CDP Input, while recording a
// CPU profile bracketing just that interaction, to find exactly what's inside the
// multi-second NAV window the debug bar reports on session-tab switches.
const HOST = "127.0.0.1"
const PORT = 9222

async function main() {
  const list = await fetch(`http://${HOST}:${PORT}/json/list`).then((r) => r.json())
  const page = list.find((t) => t.type === "page" && t.title === "OpenCode")
  if (!page) throw new Error("OpenCode page target not found")

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
  await send("Profiler.enable")
  await send("Profiler.setSamplingInterval", { interval: 100 })

  const tabsResult = await send("Runtime.evaluate", {
    expression: `
      JSON.stringify({
        current: location.pathname,
        tabs: [...document.querySelectorAll("a[href]")]
          .filter(a => a.getAttribute("href")?.includes("/session/"))
          .map(el => { const r = el.getBoundingClientRect(); return { href: el.getAttribute("href"), x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2) } })
      })
    `,
    returnByValue: true,
  })
  const { current, tabs } = JSON.parse(tabsResult.result.result.value)
  const target = tabs.find((t) => !current.includes(t.href.split("?")[0].split("/session/")[1]))
  if (!target) throw new Error("No alternate tab found to click: " + JSON.stringify({ current, tabs }))
  console.error(`[nav-profile] current=${current} clicking tab at (${target.x},${target.y}) -> ${target.href}`)

  await send("Profiler.start")
  const profileStartLocal = Date.now()

  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: target.x, y: target.y, button: "left", clickCount: 1 })
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 })

  await new Promise((r) => setTimeout(r, 3500))
  const stopped = await send("Profiler.stop")
  const profile = stopped.result.profile

  const nodeById = new Map(profile.nodes.map((n) => [n.id, n]))
  const samples = profile.samples ?? []
  const timeDeltas = profile.timeDeltas ?? []
  const bucket = new Map()
  let cumUs = 0
  for (let i = 0; i < samples.length; i++) {
    cumUs += Math.max(timeDeltas[i] ?? 0, 0)
    const n = nodeById.get(samples[i])
    const cf = n?.callFrame ?? {}
    const key = `${cf.functionName || "(anonymous)"} | ${cf.url || ""}:${cf.lineNumber}`
    bucket.set(key, (bucket.get(key) ?? 0) + 1)
  }
  const total = samples.length
  const ranked = [...bucket.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)
  console.log(`\n=== ${total} samples over the click->settle window ===`)
  for (const [key, count] of ranked) console.log(`${((count / total) * 100).toFixed(1)}%\t${count}\t${key}`)

  const fs = await import("node:fs")
  fs.writeFileSync("cdp-nav-profile-out.cpuprofile", JSON.stringify(profile))
  ws.close()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
