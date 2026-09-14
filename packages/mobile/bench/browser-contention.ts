import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"

type CdpResponse = { id?: number; result?: unknown; error?: unknown; method?: string; params?: unknown }

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
    "/usr/bin/chromium-browser",
  ].filter((value): value is string => !!value)
  const found = candidates.find(existsSync)
  if (!found) throw new Error(`No Chrome/Edge executable found; checked ${candidates.join(", ")}`)
  return found
}

async function eventually<T>(fn: () => Promise<T | undefined>, timeout = 15_000) {
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
      const message = JSON.parse(String(event.data)) as CdpResponse
      if (message.id === undefined) return
      const wait = this.pending.get(message.id)
      if (!wait) return
      this.pending.delete(message.id)
      if (message.error) wait.reject(new Error(JSON.stringify(message.error)))
      else wait.resolve(message.result)
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

async function main() {
  const executable = browserExecutable()
  const profile = await mkdtemp(join(tmpdir(), "opencode-mobile-perf-"))
  const port = 9339
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

    const rows: unknown[] = []
    for (const messages of [100, 500, 1_000, 5_000]) {
      const target = await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:3301/?mock&chat=${messages}`)}`,
        { method: "PUT" },
      ).then((response) => response.json() as Promise<{ id: string; webSocketDebuggerUrl: string }>)
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
      await cdp.send("Runtime.enable")
      await cdp.send("Page.enable")
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
          window.__mobilePerfLongTasks = [];
          try {
            new PerformanceObserver(list => {
              for (const entry of list.getEntries()) window.__mobilePerfLongTasks.push({ start: entry.startTime, duration: entry.duration });
            }).observe({ type: 'longtask', buffered: true });
          } catch {}
        `,
      })
      const started = performance.now()
      // The target URL begins loading before CDP attaches. Polling the actual UI
      // gives us an end-to-end ready boundary independent of Page event races.
      await eventually(async () => {
        const result: any = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector('.chat-view') !== null`,
          returnByValue: true,
        })
        return result?.result?.value ? true : undefined
      }, 60_000)
      const readyMs = performance.now() - started

      const result: any = await cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const navigationReadyMs = performance.now();
          const intervals = [];
          let previous = performance.now();
          for (let i = 0; i < 90; i++) {
            await new Promise(resolve => requestAnimationFrame(now => {
              intervals.push(now - previous);
              previous = now;
              resolve();
            }));
          }
          intervals.sort((a, b) => a - b);
          const scroller = document.querySelector('.chat-messages');
          const mounted = [...document.querySelectorAll('.msg-block')];
          const lastMountedText = mounted.at(-1)?.textContent || '';
          const resizeIntervals = [];
          if (${messages} > ${160} && mounted.length) {
            const target = mounted.at(-1);
            let prev = performance.now();
            for (let i = 0; i < 60; i++) {
              target.style.paddingBottom = i % 2 ? '0px' : '24px';
              await new Promise(resolve => requestAnimationFrame(now => {
                resizeIntervals.push(now - prev);
                prev = now;
                resolve();
              }));
            }
            target.style.paddingBottom = '';
            resizeIntervals.sort((a, b) => a - b);
          }
          const tasks = window.__mobilePerfLongTasks || [];
          return {
            messages: ${messages},
            navigationReadyMs,
            domNodes: document.querySelectorAll('*').length,
            messageBlocks: document.querySelectorAll('.msg-block').length,
            heapBytes: performance.memory?.usedJSHeapSize,
            bottomDistance: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null,
            lastMountedTail: lastMountedText.slice(-120),
            longTasks: tasks.length,
            longTaskMs: tasks.reduce((sum, task) => sum + task.duration, 0),
            frameP95Ms: intervals[Math.floor(intervals.length * 0.95)] || 0,
            frameMaxMs: intervals.at(-1) || 0,
            resizeFrameP95Ms: resizeIntervals.length ? resizeIntervals[Math.floor(resizeIntervals.length * 0.95)] : 0,
            resizeFrameMaxMs: resizeIntervals.at(-1) || 0,
          };
        })()`,
      })
      rows.push({ ...result.result.value, readyMs })
      cdp.close()
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
    }
    console.log(`MOBILE_CHAT_METRICS=${JSON.stringify(rows)}`)

    const sessionRows: unknown[] = []
    for (const sessions of [100, 1_000, 2_000, 5_000]) {
      const target = await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(`http://127.0.0.1:3301/?mock&large=${sessions}`)}`,
        { method: "PUT" },
      ).then((response) => response.json() as Promise<{ id: string; webSocketDebuggerUrl: string }>)
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl)
      await cdp.send("Runtime.enable")
      const started = performance.now()
      await eventually(async () => {
        const result: any = await cdp.send("Runtime.evaluate", {
          expression: `document.querySelector('.sessions-header') !== null && document.querySelector('.session-row') !== null`,
          returnByValue: true,
        })
        return result?.result?.value ? true : undefined
      }, 60_000)
      const readyMs = performance.now() - started

      const result: any = await cdp.send("Runtime.evaluate", {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const intervals = [];
          let previous = performance.now();
          for (let i = 0; i < 90; i++) {
            await new Promise(resolve => requestAnimationFrame(now => {
              intervals.push(now - previous);
              previous = now;
              resolve();
            }));
          }
          intervals.sort((a, b) => a - b);
          const scroller = document.querySelector('.view-scroll');
          if (scroller) scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const mounted = [...document.querySelectorAll('.session-row')];
          return {
            sessions: ${sessions},
            domNodes: document.querySelectorAll('*').length,
            mountedSessionRows: mounted.length,
            heapBytes: performance.memory?.usedJSHeapSize,
            bottomDistance: scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight : null,
            lastMountedText: mounted.at(-1)?.textContent?.slice(-100) || '',
            frameP95Ms: intervals[Math.floor(intervals.length * 0.95)] || 0,
            frameMaxMs: intervals.at(-1) || 0,
          };
        })()`,
      })
      sessionRows.push({ ...result.result.value, readyMs })
      cdp.close()
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`)
    }
    console.log(`MOBILE_SESSION_METRICS=${JSON.stringify(sessionRows)}`)
  } finally {
    browser.kill()
    await rm(profile, { recursive: true, force: true }).catch(() => {})
  }
}

await main()
