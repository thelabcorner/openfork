import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

type CdpMessage = { id?: number; result?: unknown; error?: unknown }

function browserExecutable() {
  const env = process.env
  const candidates = [
    env.PROGRAMFILES && join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
    env["PROGRAMFILES(X86)"] && join(env["PROGRAMFILES(X86)"]!, "Google", "Chrome", "Application", "chrome.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
    env.PROGRAMFILES && join(env.PROGRAMFILES, "Microsoft", "Edge", "Application", "msedge.exe"),
    env["PROGRAMFILES(X86)"] && join(env["PROGRAMFILES(X86)"]!, "Microsoft", "Edge", "Application", "msedge.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter((value): value is string => !!value)
  const found = candidates.find(existsSync)
  if (!found) throw new Error(`No Chrome/Edge executable found; checked ${candidates.join(", ")}`)
  return found
}

async function eventually<T>(fn: () => Promise<T | undefined>, timeout = 20_000) {
  const end = performance.now() + timeout
  while (performance.now() < end) {
    const value = await fn().catch(() => undefined)
    if (value !== undefined) return value
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for browser")
}

class Cdp {
  private id = 0
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  constructor(private socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage
      if (message.id === undefined) return
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
  }

  static async connect(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true })
      socket.addEventListener("error", () => reject(new Error("CDP websocket failed")), { once: true })
    })
    return new Cdp(socket)
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}) {
    const id = ++this.id
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this.socket.close()
  }
}

async function openTab(port: number, url: string) {
  const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" }).then(
    (response) => response.json() as Promise<{ id: string; webSocketDebuggerUrl: string }>,
  )
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send("Runtime.enable")
  return { target, cdp }
}

async function title(cdp: Cdp) {
  const result: any = await cdp.send("Runtime.evaluate", {
    expression: `document.querySelector('.chat-title')?.textContent ?? ''`,
    returnByValue: true,
  })
  return String(result?.result?.value ?? "")
}

const profile = await mkdtemp(join(tmpdir(), "opencode-mobile-push-"))
const port = 9341
const browser = spawn(
  browserExecutable(),
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "about:blank",
  ],
  { stdio: "ignore" },
)

try {
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    return response.ok ? true : undefined
  })

  const expected = "Fix quota window aggregation for Go plan"

  // Cold notification click: sw.js calls clients.openWindow(target). Loading
  // that exact target must bootstrap directly into the requested session.
  const coldStarted = performance.now()
  const cold = await openTab(port, "http://127.0.0.1:3301/?mock&session=s2")
  await eventually(async () => ((await title(cold.cdp)) === expected ? true : undefined), 30_000)
  const coldMs = performance.now() - coldStarted
  const coldTitle = await title(cold.cdp)
  cold.cdp.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${cold.target.id}`).catch(() => undefined)

  // Warm notification click: sw.js focuses an existing window and postMessages
  // PUSH_NAVIGATE. Dispatch through ServiceWorkerContainer so main.tsx's real
  // message bridge, DOM event and App selectSession path all participate.
  const warm = await openTab(port, "http://127.0.0.1:3301/?mock")
  await eventually(async () => ((await title(warm.cdp)) === "Overhaul mobile PWA to match mockup" ? true : undefined), 30_000)
  const warmStarted = performance.now()
  await warm.cdp.send("Runtime.evaluate", {
    expression: `navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'PUSH_NAVIGATE', url: location.origin + '/?session=s2' } }))`,
  })
  await eventually(async () => ((await title(warm.cdp)) === expected ? true : undefined), 10_000)
  const warmMs = performance.now() - warmStarted
  const warmTitle = await title(warm.cdp)

  console.log(`MOBILE_PUSH_METRICS=${JSON.stringify({ coldMs, coldTitle, warmMs, warmTitle })}`)
  warm.cdp.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${warm.target.id}`).catch(() => undefined)
} finally {
  browser.kill()
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
