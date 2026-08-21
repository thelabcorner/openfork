// Connects to the backend sidecar's Node inspector (127.0.0.1:9229) and
// profiles active handles, specifically counting and categorizing fs.FSWatcher
// instances by their watched path. Run with:
//   bun packages/app/scripts/cdp-fswatcher.mjs [duration_ms] [interval_ms]
const DURATION_MS = Number(process.argv[2] ?? 60000)
const INTERVAL_MS = Number(process.argv[3] ?? 5000)
const HOST = "127.0.0.1"
const PORT = 9229

async function snapshotFswatcherHandles() {
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

  // Expression that inspects _getActiveHandles() and categorizes them,
  // extracting FSWatcher paths and constructor names.
  const probeExpr = `
    (() => {
      const handles = process._getActiveHandles();
      const byType = {};
      const fswatchers = [];
      let totalCount = 0;
      for (const h of handles) {
        totalCount++;
        const ctor = h.constructor?.name || typeof h;
        byType[ctor] = (byType[ctor] || 0) + 1;
        if (ctor === 'FSWatcher' || h._isInsideChokidar || h._ignoreMatcher) {
          const entry = {
            ctor: ctor,
            path: h.path || h._path || h.filename || h.watchedPath || undefined,
            recursive: h._isRecursive || undefined,
            persistent: h._persistent || undefined,
            hasIgnoreMatcher: !!h._ignoreMatcher,
            signalCount: h.close ? 1 : 0,
          };
          if (h._watchers && Array.isArray(h._watchers)) entry.childWatchers = h._watchers.length;
          fswatchers.push(entry);
        }
      }
      const fswatcherPaths = {};
      for (const fs of fswatchers) {
        const key = fs.path || '(no path)';
        fswatcherPaths[key] = (fswatcherPaths[key] || 0) + 1;
      }
      return JSON.stringify({
        totalHandles: totalCount,
        byType,
        fsWatcherCount: fswatchers.length,
        fsWatcherPaths,
        sampleFsWatchers: fswatchers.slice(0, 20).map(f => ({ ctor: f.ctor, path: f.path, hasIgnoreMatcher: f.hasIgnoreMatcher })),
      });
    })()
  `

  const start = Date.now()
  console.log(`[cdp-fswatcher] connected, probing for ${DURATION_MS}ms`)

  const results = []
  const timer = setInterval(async () => {
    const t = ((Date.now() - start) / 1000).toFixed(1)
    try {
      const result = await send("Runtime.evaluate", { expression: probeExpr, returnByValue: true })
      const value = result.result?.result?.value
      if (value) {
        const data = JSON.parse(value)
        results.push({ t: Number(t), ...data })
        const types = Object.entries(data.byType)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([name, count]) => `${count} ${name}`)
          .join(", ")
        console.log(
          `[+${t}s] total=${data.totalHandles} fsWatchers=${data.fsWatcherCount} topTypes=[${types}]`,
        )
        if (Object.keys(data.fsWatcherPaths).length > 0) {
          const topPaths = Object.entries(data.fsWatcherPaths)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([path, count]) => `${count}x ${path}`)
            .join(", ")
          console.log(`         topPaths=[${topPaths}]`)
        }
      }
    } catch (e) {
      console.error(`[+${t}s] probe error:`, e.message)
    }
  }, INTERVAL_MS)

  await new Promise((r) => setTimeout(r, DURATION_MS))
  clearInterval(timer)

  // Print summary
  console.log(`\n=== ${results.length} probes collected over ${DURATION_MS}ms ===`)
  if (results.length >= 2) {
    const first = results[0]
    const last = results[results.length - 1]
    const delta = last.totalHandles - first.totalHandles
    const fsDelta = last.fsWatcherCount - first.fsWatcherCount
    console.log(`Handles: ${first.totalHandles} -> ${last.totalHandles} (delta=${delta})`)
    console.log(`FSWatchers: ${first.fsWatcherCount} -> ${last.fsWatcherCount} (delta=${fsDelta})`)
  }

  // Export raw data
  const fs = await import("node:fs")
  fs.writeFileSync("cdp-fswatcher-out.json", JSON.stringify(results, null, 2))
  console.log("\nFull data written to cdp-fswatcher-out.json")
  ws.close()
}

async function main() {
  try {
    await snapshotFswatcherHandles()
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

main()
