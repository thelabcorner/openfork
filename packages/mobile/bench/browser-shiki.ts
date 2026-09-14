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
    await Bun.sleep(50)
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

const executable = browserExecutable()
const profile = await mkdtemp(join(tmpdir(), "opencode-mobile-shiki-"))
const port = 9340
const browser = spawn(
  executable,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--enable-precise-memory-info",
    "about:blank",
  ],
  { stdio: "ignore" },
)

try {
  await eventually(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`)
    return response.ok ? true : undefined
  })

  const target = await fetch(
    `http://127.0.0.1:${port}/json/new?${encodeURIComponent("http://127.0.0.1:3301/?mock")}`,
    { method: "PUT" },
  ).then((response) => response.json() as Promise<{ id: string; webSocketDebuggerUrl: string }>)
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
  await cdp.send("Runtime.enable")

  const readyMs = await eventually(async () => {
    const result: any = await cdp.send("Runtime.evaluate", {
      expression: `({ ready: document.readyState, hasApp: document.querySelector('.chat-view, .sessions-view, .sessions-header, .connect-view') !== null, now: performance.now() })`,
      returnByValue: true,
    })
    const value = result?.result?.value
    return value?.hasApp ? Number(value.now) : undefined
  }, 60_000)

  const result: any = await cdp.send("Runtime.evaluate", {
    awaitPromise: true,
    returnByValue: true,
    expression: `(async () => {
      performance.clearResourceTimings();
      const heap0 = performance.memory?.usedJSHeapSize ?? 0;
      const importStart = performance.now();
      const highlighter = await import('/src/markdown/highlight.ts');
      const importMs = performance.now() - importStart;

      const coldStart = performance.now();
      await Promise.race([
        highlighter.highlightCode('const value: number = 42\\nconsole.log(value)', 'ts'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('cold highlight timeout')), 15000)),
      ]);
      const coldMs = performance.now() - coldStart;
      const heap1 = performance.memory?.usedJSHeapSize ?? 0;

      const warm = [];
      for (let i = 0; i < 16; i++) {
        const started = performance.now();
        await highlighter.highlightCode('const value: number = ' + i, 'ts');
        warm.push(performance.now() - started);
      }
      warm.sort((a, b) => a - b);

      const pythonStart = performance.now();
      await highlighter.highlightCode('value: int = 42\\nprint(value)', 'py');
      const pythonFirstMs = performance.now() - pythonStart;
      const heap2 = performance.memory?.usedJSHeapSize ?? 0;

      const resources = performance.getEntriesByType('resource')
        .filter(entry => /shiki|github-dark|typescript|python|engine-javascript/i.test(entry.name))
        .map(entry => ({
          name: entry.name.split('/').pop(),
          transferSize: entry.transferSize ?? 0,
          encodedBodySize: entry.encodedBodySize ?? 0,
          duration: entry.duration,
        }));

      return {
        importMs,
        coldMs,
        warmMedianMs: warm[Math.floor(warm.length / 2)] ?? 0,
        warmP95Ms: warm[Math.min(warm.length - 1, Math.floor(warm.length * 0.95))] ?? 0,
        warmMaxMs: warm.at(-1) ?? 0,
        pythonFirstMs,
        coldHeapDelta: heap1 - heap0,
        pythonHeapDelta: heap2 - heap1,
        transferBytes: resources.reduce((sum, resource) => sum + resource.transferSize, 0),
        resources,
      };
    })()`,
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  console.log(`MOBILE_SHIKI_METRICS=${JSON.stringify({ readyMs, ...result.result.value })}`)
  cdp.close()
  await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`).catch(() => undefined)
} finally {
  browser.kill()
  await rm(profile, { recursive: true, force: true }).catch(() => {})
}
