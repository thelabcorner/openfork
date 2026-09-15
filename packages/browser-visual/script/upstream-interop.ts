import { createHash } from "node:crypto"
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { BrowserDispatchContext } from "../../desktop/src/main/browser/contracts"
import { VisualObservationCoordinator } from "../../desktop/src/main/browser/visual/coordinator"
import { OpenCodeSnapEyeStore } from "../../desktop/src/main/browser/visual/store"

const chrome = process.env.CHROME_PATH ?? (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome")

const snapeyeCli = resolve(import.meta.dir, "../node_modules/@zumer/snapeye/src/cli.js")
const snapdomDist = resolve(import.meta.dir, "../node_modules/@zumer/snapdom/dist")
// Keep the served fixture under the worktree on Windows. Vite's fs allow-list
// can otherwise compare the long %TEMP% path against its 8.3 SLOOSH~1 spelling
// and reject the file before SnapEye's injected client ever runs.
const project = await mkdtemp(resolve(import.meta.dir, "../.interop-"))
const chromeProfile = await mkdtemp(join(tmpdir(), "opencode-snapeye-upstream-chrome-"))
const fixturePath = join(project, "fixture.html")
const artifactRoot = join(project, ".snapeye")
const upstreamPorts = new Set<number>()
await writeFile(fixturePath, fixtureHtml(), "utf8")

const fixtureServer = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname !== "/fixture.html") return new Response("not found", { status: 404 })
    return new Response(fixtureHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
  },
})

const browser = Bun.spawn([
  chrome,
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${chromeProfile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "about:blank",
], { stdout: "ignore", stderr: "pipe" })

try {
  const port = await readDevtoolsPort(chromeProfile)
  const version = await waitForJson<{ Browser?: string }>(`http://127.0.0.1:${port}/json/version`)
  const targets = await waitForJson<Array<{ type: string; webSocketDebuggerUrl?: string }>>(`http://127.0.0.1:${port}/json/list`)
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a page target")
  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await cdp.send("Page.enable")
    await cdp.send("Runtime.enable")
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false })

    const harnessBuild = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../test/chromium-harness-entry.ts")],
      target: "browser",
      format: "iife",
      minify: true,
      sourcemap: "none",
    })
    if (!harnessBuild.success || harnessBuild.outputs.length !== 1) {
      throw new Error(`Failed to build interoperability harness: ${harnessBuild.logs.map(String).join("\n")}`)
    }
    const harnessSource = await harnessBuild.outputs[0]!.text()

    // -----------------------------------------------------------------------
    // Direction A: OpenCode runtime + coordinator/store -> upstream CLI diff.
    // -----------------------------------------------------------------------
    await navigate(cdp, `http://127.0.0.1:${fixtureServer.port}/fixture.html`)
    await evaluate(cdp, harnessSource)
    const openCodeCapture = await callHarness(cdp, "capture", ["opencode-to-upstream", "#fixture"])
    if (openCodeCapture.result?.status !== "ok" || openCodeCapture.result?.operation !== "capture") {
      throw new Error(`OpenCode harness capture failed: ${JSON.stringify(openCodeCapture.result)}`)
    }

    const openCodeImage = Buffer.from(openCodeCapture.baseline.image, "base64")
    const engineMajor = chromiumMajor(version.Browser)
    const coordinator = new VisualObservationCoordinator()
    const captureGrant = await coordinator.begin({
      context: brokerContext(project, "opencode-capture"),
      lane: "extension",
      tabId: "interop-chrome",
      operation: "capture",
      name: "opencode-to-upstream",
      runId: openCodeCapture.result.runId,
      environment: {
        engineMajor,
        appearance: "light",
        snapeyeVersion: "0.4.0",
        snapdomVersion: "3.0.0",
      },
    })
    const baselineWrite = await coordinator.baselineWriteBegin(
      captureGrant.capability,
      "opencode-to-upstream",
      openCodeCapture.baseline.meta,
      openCodeImage.byteLength,
    )
    for (let offset = 0; offset < openCodeImage.byteLength;) {
      const end = Math.min(openCodeImage.byteLength, offset + captureGrant.maxChunkBytes)
      const chunk = openCodeImage.subarray(offset, end)
      await coordinator.writeChunk(captureGrant.capability, baselineWrite.writeId, offset, chunk)
      offset = end
    }
    await coordinator.writeCommit(captureGrant.capability, baselineWrite.writeId)
    await coordinator.resultCommit(captureGrant.capability, openCodeCapture.result.runId, openCodeCapture.result)

    const openCodeStoredMeta = JSON.parse(await readFile(join(artifactRoot, "baselines", "opencode-to-upstream.json"), "utf8"))
    if (openCodeStoredMeta?.opencode?.snapdomVersion !== "3.0.0") {
      throw new Error("OpenCode baseline did not contain the expected additive environment fingerprint")
    }

    const upstreamDiff = await runUpstreamCli(cdp, {
      operation: "diff",
      name: "opencode-to-upstream",
      runId: "updiff1",
    })
    assertUnchanged(upstreamDiff, "OpenCode baseline -> upstream CLI diff")

    // -----------------------------------------------------------------------
    // Direction B: upstream CLI capture/store -> OpenCode store/runtime diff.
    // -----------------------------------------------------------------------
    const upstreamCapture = await runUpstreamCli(cdp, {
      operation: "capture",
      name: "upstream-to-opencode",
      runId: "upcap1",
    })
    if (upstreamCapture?.status !== "ok" || upstreamCapture?.operation !== "capture") {
      throw new Error(`Upstream capture failed: ${JSON.stringify(upstreamCapture)}`)
    }

    const openCodeStore = await OpenCodeSnapEyeStore.create(project)
    const upstreamBaseline = await openCodeStore.readBaseline("upstream-to-opencode")
    if (!upstreamBaseline) throw new Error("OpenCode store could not read the upstream baseline")

    // The upstream baseline has no OpenCode fingerprint. The coordinator must
    // accept it as legacy/upstream metadata rather than inventing a mismatch.
    const readCoordinator = new VisualObservationCoordinator()
    const diffGrant = await readCoordinator.begin({
      context: brokerContext(project, "opencode-diff"),
      lane: "extension",
      tabId: "interop-chrome",
      operation: "diff",
      name: "upstream-to-opencode",
      runId: "ocdiff1",
      environment: {
        engineMajor,
        appearance: "light",
        snapeyeVersion: "0.4.0",
        snapdomVersion: "3.0.0",
      },
    })
    const opened = await readCoordinator.baselineReadOpen(diffGrant.capability, "upstream-to-opencode")
    if (!opened) throw new Error("OpenCode coordinator could not open the upstream baseline")
    await readCoordinator.baselineReadClose(diffGrant.capability, opened.readId)
    await readCoordinator.abort(diffGrant.capability)

    // A CLI operation reloads the page, so reinstall the OpenCode harness into
    // the fresh document and feed it the baseline that the OpenCode host store
    // just accepted and integrity-verified.
    await navigate(cdp, `http://127.0.0.1:${fixtureServer.port}/fixture.html`)
    await evaluate(cdp, harnessSource)
    await callHarness(cdp, "importBaseline", ["upstream-to-opencode", {
      image: Buffer.from(upstreamBaseline.image).toString("base64"),
      meta: upstreamBaseline.meta,
    }])
    const openCodeDiff = await callHarness(cdp, "diff", ["upstream-to-opencode", "#fixture"])
    assertUnchanged(openCodeDiff.result, "upstream CLI baseline -> OpenCode runtime diff")

    const upstreamImage = Buffer.from(upstreamBaseline.image)
    const openCodeHash = sha256(openCodeImage)
    const upstreamHash = sha256(upstreamImage)
    console.log(JSON.stringify({
      ok: true,
      snapeyeVersion: "0.4.0",
      snapdomVersion: "3.0.0",
      chromium: version.Browser ?? null,
      openCodeToUpstream: {
        upstreamChanged: upstreamDiff.diff?.changed,
        baselineSha256: openCodeHash,
        additiveMetadataPreserved: true,
      },
      upstreamToOpenCode: {
        openCodeChanged: openCodeDiff.result?.diff?.changed,
        baselineSha256: upstreamHash,
        openCodeStoreAccepted: true,
        openCodeCoordinatorAcceptedUnfingerprintedBaseline: true,
      },
      exactBaselineBytesEqual: openCodeHash === upstreamHash,
    }, null, 2))
  } finally {
    cdp.close()
  }
} finally {
  fixtureServer.stop(true)
  browser.kill()
  browser.unref()
  await Promise.race([
    browser.exited.catch(() => undefined),
    Bun.sleep(1_000),
  ])
  await rm(project, { recursive: true, force: true }).catch(() => undefined)
  await rm(chromeProfile, { recursive: true, force: true }).catch(() => undefined)
}

type CliOperation = "capture" | "diff"

async function runUpstreamCli(
  cdp: Cdp,
  input: { operation: CliOperation; name: string; runId: string },
): Promise<any> {
  // Child stdout/stderr intentionally go to files rather than Bun pipes. On
  // Windows, pipe EOF / reader.cancel() can remain pending after node.exe has
  // already exited and SnapEye has atomically published result.json. A verifier
  // must not turn that runtime quirk into a false interoperability failure.
  const stdoutPath = join(project, `.upstream-${input.runId}.stdout.log`)
  const stderrPath = join(project, `.upstream-${input.runId}.stderr.log`)
  const stdoutFile = await open(stdoutPath, "w")
  const stderrFile = await open(stderrPath, "w")
  const port = await allocateUpstreamPort()
  let exitCode: number | null | undefined
  const child = Bun.spawn([
    "node",
    snapeyeCli,
    input.operation,
    input.name,
    "--serve",
    fixturePath,
    "--root",
    artifactRoot,
    "--snapdom",
    snapdomDist,
    "--port",
    String(port),
    "--target",
    "#fixture",
    "--run",
    input.runId,
    "--timeout",
    "15000",
    "--no-open",
  ], {
    cwd: project,
    stdout: stdoutFile.fd,
    stderr: stderrFile.fd,
    onExit(_subprocess, code) {
      exitCode = code
    },
  })
  child.unref()

  try {
    const triggerUrl = await waitForTriggerUrl(stderrPath, () => exitCode, 10_000)
    const served = await fetch(triggerUrl, {
      headers: { connection: "close" },
      signal: AbortSignal.timeout(3_000),
    })
    const servedHtml = await served.text()
    if (!served.ok || !servedHtml.includes("data-snapeye-client")) {
      throw new Error(
        `Upstream standalone HTML injection failed before browser execution: HTTP ${served.status}, ` +
        `clientTag=${servedHtml.includes("data-snapeye-client")}, html=${JSON.stringify(servedHtml.slice(0, 500))}\n${await readLog(stderrPath)}`,
      )
    }
    await navigate(cdp, triggerUrl)

    // Fail fast with browser-side evidence instead of burning the full CLI
    // timeout when the standalone host did not actually inject/boot its client.
    await Bun.sleep(250)
    const pageState = await evaluate(cdp, `(() => ({
      href: location.href,
      snapeyeType: typeof globalThis.snapeye,
      snapeyeProtocolVersion: globalThis.snapeye?.protocolVersion ?? null,
      bootstrapInstalled: !!globalThis[Symbol.for('@zumer/snapeye/vite-client')],
      scripts: Array.from(document.scripts).map((script) => script.src || '<inline>')
    }))()`)
    if (pageState?.snapeyeType !== "object") {
      throw new Error(`Upstream standalone page did not boot SnapEye: ${JSON.stringify(pageState)}\n${await readLog(stderrPath)}`)
    }

    // result.json is SnapEye's atomic terminal correctness boundary. Do not
    // make certification depend on Bun/Windows eventually reporting process
    // exit after that terminal state already exists.
    const result = await waitForTerminalResult(
      join(artifactRoot, "runs", input.runId, "result.json"),
      20_000,
      () => exitCode,
      stderrPath,
    )
    await settleTerminalVerifierChild(child, () => exitCode)
    return result
  } finally {
    // Failure before terminal publication still owns the CLI lifetime. Never
    // await child.exited here: delayed/missed Windows exit notification is the
    // behavior this verifier is explicitly designed not to depend on.
    if (exitCode === undefined) child.kill()
    await Promise.all([
      stdoutFile.close().catch(() => undefined),
      stderrFile.close().catch(() => undefined),
    ])
  }
}

async function waitForTriggerUrl(
  stderrPath: string,
  getExitCode: () => number | null | undefined,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const text = await readLog(stderrPath)
    const match = text.match(/snapeye:\s+(https?:\/\/\S+__snapeye=[^\s]+)/)
    if (match?.[1]) return match[1]
    const code = getExitCode()
    if (code !== undefined) {
      throw new Error(`Upstream CLI exited ${String(code)} before emitting a trigger URL\n${text}`)
    }
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for upstream CLI trigger URL\n${await readLog(stderrPath)}`)
}

async function waitForTerminalResult(
  path: string,
  timeoutMs: number,
  getExitCode: () => number | null | undefined,
  stderrPath: string,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const raw = await readFile(path, "utf8")
      return JSON.parse(raw)
    } catch (error) {
      lastError = error
    }
    const code = getExitCode()
    if (code !== undefined && code !== 0) {
      throw new Error(
        `Upstream CLI exited ${String(code)} before publishing terminal result ${path}: ${String(lastError)}\n${await readLog(stderrPath)}`,
      )
    }
    await Bun.sleep(25)
  }
  throw new Error(`Timed out waiting for upstream terminal result ${path}: ${String(lastError)}\n${await readLog(stderrPath)}`)
}

async function settleTerminalVerifierChild(
  child: ReturnType<typeof Bun.spawn>,
  getExitCode: () => number | null | undefined,
): Promise<void> {
  // Give the successful CLI a small graceful-exit window. Once result.json is
  // durable there is no correctness value in waiting indefinitely for Windows
  // process teardown; force only this disposable verifier child if needed.
  const deadline = Date.now() + 500
  while (Date.now() < deadline && getExitCode() === undefined) await Bun.sleep(25)
  if (getExitCode() === undefined) child.kill()
}

async function readLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""
    throw error
  }
}

async function allocateUpstreamPort(): Promise<number> {
  // SnapEye's `--port` parser requires a positive integer, while its Vite
  // default can repeatedly reuse 5173. Ask the OS for an ephemeral port, close
  // the probe immediately, and ensure this verifier never intentionally reuses
  // an origin within the same interoperability run.
  for (let attempt = 0; attempt < 16; attempt++) {
    const probe = Bun.serve({ port: 0, fetch: () => new Response("probe") })
    const port = probe.port
    probe.stop(true)
    if (upstreamPorts.has(port)) continue
    upstreamPorts.add(port)
    return port
  }
  throw new Error("Could not allocate a unique ephemeral port for upstream SnapEye verification")
}

function brokerContext(directory: string, suffix: string): BrowserDispatchContext {
  return {
    requestId: `req-${suffix}`,
    sessionId: "ses-upstream-interop",
    windowId: "win-upstream-interop",
    workspaceId: "workspace-upstream-interop",
    directory,
    messageId: `msg-${suffix}`,
    toolCallId: `tool-${suffix}`,
    timeoutMs: 30_000,
  }
}

function assertUnchanged(result: any, label: string) {
  if (result?.status !== "ok" || result?.operation !== "diff" || result?.diff?.changed !== false) {
    throw new Error(`${label} was not unchanged: ${JSON.stringify(result)}`)
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function chromiumMajor(browser: string | undefined): number | undefined {
  const match = browser?.match(/(?:Chrome|Chromium)\/(\d+)/)
  if (!match?.[1]) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : undefined
}

async function readDevtoolsPort(directory: string): Promise<number> {
  const file = join(directory, "DevToolsActivePort")
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const value = await readFile(file, "utf8")
      const port = Number.parseInt(value.split(/\r?\n/, 1)[0] ?? "", 10)
      if (Number.isFinite(port)) return port
    } catch {}
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for Chrome DevToolsActivePort")
}

async function waitForJson<T>(url: string): Promise<T> {
  const deadline = Date.now() + 10_000
  let last: unknown
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return await response.json() as T
      last = new Error(`HTTP ${response.status}`)
    } catch (error) {
      last = error
    }
    await Bun.sleep(25)
  }
  throw last instanceof Error ? last : new Error(`Timed out fetching ${url}`)
}

async function navigate(cdp: Cdp, url: string): Promise<void> {
  const loaded = cdp.once("Page.loadEventFired")
  await cdp.send("Page.navigate", { url })
  await loaded
}

async function evaluate(cdp: Cdp, expression: string): Promise<any> {
  const response = await cdp.send<any>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime.evaluate failed")
  }
  return response.result?.value
}

async function callHarness(cdp: Cdp, method: string, args: unknown[]): Promise<any> {
  return evaluate(cdp, `globalThis.__opencodeSnapEyeHarness.${method}(...${JSON.stringify(args)})`)
}

class Cdp {
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  private readonly waiters = new Map<string, Array<(params: any) => void>>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)))
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true })
      socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open")), { once: true })
    })
    return new Cdp(socket)
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.sequence
    return new Promise<T>((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  once(method: string): Promise<any> {
    return new Promise((resolveEvent) => {
      const list = this.waiters.get(method) ?? []
      list.push(resolveEvent)
      this.waiters.set(method, list)
    })
  }

  close() {
    for (const flight of this.pending.values()) flight.reject(new Error("CDP connection closed"))
    this.pending.clear()
    this.socket.close()
  }

  private onMessage(raw: string) {
    const message = JSON.parse(raw)
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
      else pending.resolve(message.result)
      return
    }
    if (typeof message.method !== "string") return
    const list = this.waiters.get(message.method)
    if (!list?.length) return
    this.waiters.delete(message.method)
    for (const resolveEvent of list) resolveEvent(message.params)
  }
}

function fixtureHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 800px; height: 600px; background: #f7f7f5; }
  body { padding: 48px; font-family: Arial, sans-serif; }
  #fixture { width: 640px; height: 360px; padding: 24px; background: #ffffff; border: 2px solid #18181b; border-radius: 12px; }
  .row { display: flex; gap: 16px; align-items: center; }
  .block { width: 180px; height: 120px; border-radius: 8px; background: #e4e4e7; border: 1px solid #a1a1aa; }
  #accent { width: 180px; height: 120px; border-radius: 8px; background: #ef4444; border: 1px solid #991b1b; }
  .line { margin-top: 24px; width: 592px; height: 48px; background: linear-gradient(90deg, #18181b 0 33%, #71717a 33% 66%, #d4d4d8 66%); }
</style>
</head>
<body>
  <main id="fixture">
    <div class="row"><div class="block"></div><div id="accent"></div><div class="block"></div></div>
    <div class="line"></div>
  </main>
</body>
</html>`
}
