import { app, BrowserWindow, type WebContents } from "electron"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import type {
  BrowserDispatchContext,
  GuestTabState,
  VisualCaptureInput,
  VisualDiffInput,
  VisualRecordInput,
} from "../src/main/browser/contracts"
import { VisualObservationCoordinator } from "../src/main/browser/visual/coordinator"
import { WebviewVisualController } from "../src/main/browser/visual/webview-controller"

const preload = process.env.OPENCODE_VISUAL_PRELOAD
if (!preload) throw new Error("OPENCODE_VISUAL_PRELOAD is required")
const resultPath = process.env.OPENCODE_VISUAL_RESULT_PATH
if (!resultPath) throw new Error("OPENCODE_VISUAL_RESULT_PATH is required")
const snapeyeCli = process.env.OPENCODE_SNAPEYE_CLI_PATH
if (!snapeyeCli) throw new Error("OPENCODE_SNAPEYE_CLI_PATH is required")
writeFileSync(`${resultPath}.loaded`, JSON.stringify({ pid: process.pid, electron: process.versions.electron ?? null }))
// The harness deliberately begins with no window while async fixture setup is
// prepared. Suppress Electron's default Windows/Linux "last window closed"
// shutdown until this harness explicitly calls app.quit() in its finalizer.
app.on("window-all-closed", () => {})

void main().then(
  () => app.quit(),
  async (error) => {
    await writeFile(
      resultPath,
      JSON.stringify({ ok: false, error: error instanceof Error ? error.stack ?? error.message : String(error) }, null, 2),
      "utf8",
    ).catch(() => undefined)
    console.error(error)
    app.exit(1)
  },
)

async function main() {
  // Keep the served interoperability fixture under the worktree on Windows.
  // Vite's standalone fs allow-list can otherwise compare a long %TEMP% path
  // against its 8.3 SLOOSH~1 spelling and reject SnapEye's injected modules.
  // The directory is still ephemeral and removed in the finalizer below.
  const project = await mkdtemp(resolve(process.cwd(), ".visual-webview-"))
  const coordinator = new VisualObservationCoordinator()
  const controller = new WebviewVisualController(coordinator)
  let win: BrowserWindow | null = null

  try {
  await app.whenReady()
  win = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(fixtureHtml())}`)

  const isolation = await win.webContents.executeJavaScript(
    `({ processType: typeof process, requireType: typeof require })`,
    true,
  ) as { processType: string; requireType: string }
  if (isolation.processType !== "undefined" || isolation.requireType !== "undefined") {
    throw new Error(`Page world escaped sandbox: ${JSON.stringify(isolation)}`)
  }

  const tab = {
    runtimeTabId: "webview-fidelity",
    lifecycleGeneration: 1,
    windowId: "fidelity",
    owner: { kind: "agent", sessionId: "ses-webview-fidelity" },
    webContentsId: win.webContents.id,
    url: win.webContents.getURL(),
    title: "fixture",
    readyState: "complete",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    colorScheme: "light",
    controller: "agent",
    generation: 1,
    crashed: false,
    attached: true,
    muted: false,
    snapshotVersion: 1,
    webContents: win.webContents,
  } satisfies GuestTabState & { webContents: WebContents }

  const captureInput: VisualCaptureInput = {
    name: "electron-fidelity",
    target: { kind: "css", selector: "#fixture" },
  }
  const captured = await controller.run(tab, "capture", captureInput, context(project, "capture"), "light")
  if (captured.visual.status !== "ok" || captured.visual.operation !== "capture") {
    throw new Error(`Electron capture failed: ${JSON.stringify(captured.visual)}`)
  }

  const baselinePath = resolve(project, ".snapeye", "baselines", "electron-fidelity.png")
  const baselineBytes = await readFile(baselinePath)
  const baselineSha256 = createHash("sha256").update(baselineBytes).digest("hex")

  await win.webContents.executeJavaScript(`document.querySelector('#accent').style.background='#0066ff'`, true)
  const changed = await controller.run(
    tab,
    "diff",
    { name: "electron-fidelity", target: { kind: "css", selector: "#fixture" } } as VisualDiffInput,
    context(project, "diff-changed"),
    "light",
  )
  if (changed.visual.status !== "ok" || changed.visual.operation !== "diff" || changed.visual.diff?.changed !== true) {
    throw new Error(`Electron diff failed to detect mutation: ${JSON.stringify(changed.visual)}`)
  }

  await win.webContents.executeJavaScript(`document.querySelector('#accent').style.background='#ef4444'`, true)
  const restored = await controller.run(
    tab,
    "diff",
    { name: "electron-fidelity", target: { kind: "css", selector: "#fixture" } } as VisualDiffInput,
    context(project, "diff-restored"),
    "light",
  )
  if (restored.visual.status !== "ok" || restored.visual.operation !== "diff" || restored.visual.diff?.changed !== false) {
    throw new Error(`Electron restored DOM was not unchanged: ${JSON.stringify(restored.visual)}`)
  }

  const redaction = {
    blocks: ["#secret-block"],
    attributes: [{ selector: "#secret-input", names: ["value"] }],
  }
  const redactedCapture = await controller.run(
    tab,
    "capture",
    { name: "electron-redacted", target: { kind: "css", selector: "#fixture" }, redact: redaction } as VisualCaptureInput,
    context(project, "redaction-capture"),
    "light",
  )
  if (redactedCapture.visual.status !== "ok" || redactedCapture.visual.operation !== "capture") {
    throw new Error(`Electron redacted capture failed: ${JSON.stringify(redactedCapture.visual)}`)
  }
  await win.webContents.executeJavaScript(`
    document.querySelector('#secret-block').textContent='CHANGED SECRET';
    document.querySelector('#secret-block').style.background='#000';
    const input=document.querySelector('#secret-input');
    input.value='changed-token';
    input.setAttribute('value','changed-token');
  `, true)
  const redactedDiff = await controller.run(
    tab,
    "diff",
    { name: "electron-redacted", target: { kind: "css", selector: "#fixture" }, redact: redaction } as VisualDiffInput,
    context(project, "redaction-diff"),
    "light",
  )
  if (redactedDiff.visual.status !== "ok" || redactedDiff.visual.operation !== "diff" || redactedDiff.visual.diff?.changed !== false) {
    throw new Error(`Electron redaction did not suppress secret-only mutations: ${JSON.stringify(redactedDiff.visual)}`)
  }

  await win.webContents.executeJavaScript(`
    document.querySelector('#accent').animate(
      [{transform:'translateX(0px)'},{transform:'translateX(24px)'}],
      {duration:240,iterations:Infinity,direction:'alternate'}
    );
  `, true)
  const recorded = await controller.run(
    tab,
    "record",
    {
      name: "electron-motion",
      target: { kind: "css", selector: "#fixture" },
      duration: 300,
      fps: 6,
      format: "both",
      scale: 1,
    } as VisualRecordInput,
    context(project, "record"),
    "light",
  )
  if (
    recorded.visual.status !== "ok" ||
    recorded.visual.operation !== "record" ||
    !recorded.visual.record ||
    recorded.visual.record.frameCount < 2 ||
    recorded.visual.artifacts?.frames !== "frames.png" ||
    recorded.visual.artifacts?.gif !== "recording.gif" ||
    (recorded.visual.artifacts?.video !== "recording.webm" && recorded.visual.artifacts?.video !== "recording.mp4")
  ) {
    throw new Error(`Electron visual record failed: ${JSON.stringify(recorded.visual)}`)
  }

  const abortController = new AbortController()
  const abortContext = context(project, "record-abort", abortController.signal)
  const abortStarted = Date.now()
  const abortPromise = controller.run(
    tab,
    "record",
    {
      name: "electron-motion-abort",
      runId: "electron_record_abort",
      target: { kind: "css", selector: "#fixture" },
      duration: 15_000,
      fps: 10,
      format: "gif",
      scale: 1,
    } as VisualRecordInput,
    abortContext,
    "light",
  )
  setTimeout(() => abortController.abort(), 150)
  let abortRejected = false
  try {
    await abortPromise
  } catch {
    abortRejected = true
  }
  const abortElapsedMs = Date.now() - abortStarted
  if (!abortRejected || abortElapsedMs >= 5_000) {
    throw new Error(`Electron 15s visual record was not promptly cancelled (rejected=${abortRejected}, elapsed=${abortElapsedMs}ms)`)
  }
  const abortedTerminal = await readFile(
    resolve(project, ".snapeye", "runs", "electron_record_abort", "result.json"),
    "utf8",
  ).then(() => true, () => false)
  if (abortedTerminal) throw new Error("Electron aborted visual record published result.json")

    const interop = await verifyUpstreamInterop(win, controller, project)

    const summary = {
      ok: true,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      baselineBytes: baselineBytes.byteLength,
      baselineSha256,
      mutationChangedRatio: changed.visual.diff?.changedRatio ?? null,
      restoredUnchanged: true,
      redactionHiddenMutationsUnchanged: true,
      redactionPolicySha256: redactedCapture.visual.opencode?.redactionPolicySha256 ?? null,
      visualRecordFrames: recorded.visual.record.frameCount,
      visualRecordArtifacts: recorded.visual.artifacts,
      visualRecordAbortElapsedMs: abortElapsedMs,
      visualRecordAbortPublishedTerminal: abortedTerminal,
      snapeyeProtocolVersion: captured.visual.protocolVersion,
      interop,
    }
    await writeFile(resultPath, JSON.stringify(summary, null, 2), "utf8")
    console.log(JSON.stringify(summary, null, 2))
  } finally {
    controller.stop()
    await coordinator.stop()
    if (win && !win.isDestroyed()) win.destroy()
    await rm(project, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function verifyUpstreamInterop(
  win: BrowserWindow,
  controller: WebviewVisualController,
  projectRoot: string,
) {
  const directory = join(projectRoot, "interop")
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, "fixture.html"), fixtureHtml(), "utf8")

  const server = spawn(
    "node",
    // SnapEye's CLI selects a free ephemeral port when --port is omitted.
    // Passing an explicit 0 is rejected by the public CLI parser even though
    // the underlying server helper uses 0 internally for ephemeral binding.
    [snapeyeCli, "serve", "fixture.html", "--root", ".snapeye"],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  )
  const serverErrors: string[] = []
  server.stderr.on("data", (chunk) => serverErrors.push(String(chunk)))
  try {
    const serveLine = await firstLine(server.stdout, 10_000)
    const served = JSON.parse(serveLine) as { status?: string; url?: string }
    if (served.status !== "ok" || typeof served.url !== "string") {
      throw new Error(`SnapEye CLI serve returned an invalid handshake: ${serveLine}`)
    }
    const baseUrl = served.url
    await win.loadURL(baseUrl)

    const upstreamCapture = await runSnapEyeCliOperation({
      win,
      cwd: directory,
      baseUrl,
      operation: "capture",
      name: "upstream-baseline",
      runId: "upstream-capture",
    })
    if (upstreamCapture.status !== "ok" || upstreamCapture.operation !== "capture") {
      throw new Error(`Upstream SnapEye capture failed: ${JSON.stringify(upstreamCapture)}`)
    }

    await win.loadURL(baseUrl)
    const upstreamToOpenCode = await controller.run(
      guestRecord(win, "interop-upstream-to-opencode"),
      "diff",
      { name: "upstream-baseline", target: { kind: "css", selector: "#fixture" } } as VisualDiffInput,
      context(directory, "interop-upstream-to-opencode"),
      "light",
    )
    if (
      upstreamToOpenCode.visual.status !== "ok" ||
      upstreamToOpenCode.visual.operation !== "diff" ||
      upstreamToOpenCode.visual.diff?.changed !== false
    ) {
      throw new Error(`OpenCode could not consume upstream baseline: ${JSON.stringify(upstreamToOpenCode.visual)}`)
    }

    const openCodeCapture = await controller.run(
      guestRecord(win, "interop-opencode-capture"),
      "capture",
      { name: "opencode-baseline", target: { kind: "css", selector: "#fixture" } } as VisualCaptureInput,
      context(directory, "interop-opencode-capture"),
      "light",
    )
    if (openCodeCapture.visual.status !== "ok" || openCodeCapture.visual.operation !== "capture") {
      throw new Error(`OpenCode interoperability capture failed: ${JSON.stringify(openCodeCapture.visual)}`)
    }

    const openCodeToUpstream = await runSnapEyeCliOperation({
      win,
      cwd: directory,
      baseUrl,
      operation: "diff",
      name: "opencode-baseline",
      runId: "upstream-diff-opencode",
    })
    if (openCodeToUpstream.status !== "ok" || openCodeToUpstream.operation !== "diff" || openCodeToUpstream.diff?.changed !== false) {
      throw new Error(`Upstream SnapEye could not consume OpenCode baseline: ${JSON.stringify(openCodeToUpstream)}`)
    }

    return {
      upstreamToOpenCode: true,
      openCodeToUpstream: true,
      upstreamCaptureProtocolVersion: upstreamCapture.protocolVersion ?? null,
      upstreamDiffProtocolVersion: openCodeToUpstream.protocolVersion ?? null,
    }
  } finally {
    server.kill()
    await Promise.race([
      new Promise<void>((resolveClose) => server.once("close", () => resolveClose())),
      new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, 2_000)),
    ])
    if (server.exitCode && server.exitCode !== 0 && serverErrors.length) {
      console.warn(`SnapEye serve stderr: ${serverErrors.join("")}`)
    }
  }
}

async function runSnapEyeCliOperation(input: {
  win: BrowserWindow
  cwd: string
  baseUrl: string
  operation: "capture" | "diff"
  name: string
  runId: string
}) {
  const child = spawn(
    "node",
    [
      snapeyeCli,
      input.operation,
      input.name,
      "--url",
      input.baseUrl,
      "--root",
      ".snapeye",
      "--run",
      input.runId,
      "--target",
      "#fixture",
      "--timeout",
      "15000",
      "--no-open",
    ],
    { cwd: input.cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  )

  const stdout = collect(child.stdout)
  const stderr = collect(child.stderr)
  await waitForText(child.stderr, "open this URL to run the operation:", 10_000)
  const trigger = new URL(input.baseUrl)
  trigger.searchParams.set("__snapeye", input.operation)
  trigger.searchParams.set("name", input.name)
  trigger.searchParams.set("run", input.runId)
  trigger.searchParams.set("target", "#fixture")
  await input.win.loadURL(trigger.href)
  // Fail with browser-side evidence immediately if the standalone Vite client
  // failed to boot instead of waiting for the CLI's terminal-result timeout.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 250))
  const pageState = await input.win.webContents.executeJavaScript(`(() => ({
    href: location.href,
    snapeyeType: typeof globalThis.snapeye,
    snapeyeProtocolVersion: globalThis.snapeye?.protocolVersion ?? null,
    bootstrapInstalled: !!globalThis[Symbol.for('@zumer/snapeye/vite-client')],
    scripts: Array.from(document.scripts).map((script) => script.src || '<inline>')
  }))()`, true) as {
    href?: string
    snapeyeType?: string
    snapeyeProtocolVersion?: number | null
    bootstrapInstalled?: boolean
    scripts?: string[]
  }
  if (pageState.snapeyeType !== "object") {
    child.kill()
    await new Promise<void>((resolveClose) => child.once("close", () => resolveClose())).catch(() => undefined)
    const [, err] = await Promise.all([stdout, stderr])
    throw new Error(`Upstream standalone page did not boot SnapEye: ${JSON.stringify(pageState)}\n${err}`)
  }
  const code = await new Promise<number | null>((resolveClose) => child.once("close", resolveClose))
  const [out, err] = await Promise.all([stdout, stderr])
  if (code !== 0) throw new Error(`SnapEye CLI ${input.operation} exited ${String(code)}: ${err}`)
  return JSON.parse(out) as {
    status?: string
    operation?: string
    protocolVersion?: number
    diff?: { changed?: boolean }
  }
}

function guestRecord(win: BrowserWindow, suffix: string) {
  return {
    runtimeTabId: `webview-${suffix}`,
    lifecycleGeneration: 1,
    windowId: "fidelity",
    owner: { kind: "agent", sessionId: "ses-webview-fidelity" },
    webContentsId: win.webContents.id,
    url: win.webContents.getURL(),
    title: win.webContents.getTitle(),
    readyState: "complete",
    loading: false,
    canGoBack: false,
    canGoForward: false,
    zoomFactor: 1,
    colorScheme: "light",
    controller: "agent",
    generation: 1,
    crashed: false,
    attached: true,
    muted: false,
    snapshotVersion: 1,
    webContents: win.webContents,
  } satisfies GuestTabState & { webContents: WebContents }
}

async function firstLine(stream: NodeJS.ReadableStream, timeoutMs: number): Promise<string> {
  let buffer = ""
  return new Promise<string>((resolveLine, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for SnapEye serve handshake")), timeoutMs)
    const onData = (chunk: unknown) => {
      buffer += String(chunk)
      const newline = buffer.indexOf("\n")
      if (newline < 0) return
      cleanup()
      resolveLine(buffer.slice(0, newline).trim())
    }
    const onEnd = () => {
      cleanup()
      reject(new Error(`SnapEye serve ended before handshake: ${buffer}`))
    }
    const cleanup = () => {
      clearTimeout(timer)
      stream.removeListener("data", onData)
      stream.removeListener("end", onEnd)
    }
    stream.on("data", onData)
    stream.once("end", onEnd)
  })
}

function collect(stream: NodeJS.ReadableStream): Promise<string> {
  let output = ""
  stream.on("data", (chunk) => { output += String(chunk) })
  return new Promise((resolveOutput) => stream.once("end", () => resolveOutput(output)))
}

function waitForText(stream: NodeJS.ReadableStream, needle: string, timeoutMs: number): Promise<void> {
  let text = ""
  return new Promise((resolveMatch, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for SnapEye CLI marker ${JSON.stringify(needle)}; stderr=${text}`))
    }, timeoutMs)
    const onData = (chunk: unknown) => {
      text += String(chunk)
      if (!text.includes(needle)) return
      cleanup()
      resolveMatch()
    }
    const cleanup = () => {
      clearTimeout(timer)
      stream.removeListener("data", onData)
    }
    stream.on("data", onData)
  })
}

function context(directory: string, suffix: string, signal?: AbortSignal): BrowserDispatchContext {
  return {
    requestId: `req-${suffix}`,
    sessionId: "ses-webview-fidelity",
    windowId: "fidelity",
    directory,
    messageId: `msg-${suffix}`,
    toolCallId: `tool-${suffix}`,
    timeoutMs: 30_000,
    ...(signal ? { signal } : {}),
  }
}

function fixtureHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;width:800px;height:600px;background:#f7f7f5}
body{padding:48px;font-family:Arial,sans-serif}#fixture{width:640px;height:360px;padding:24px;background:#fff;border:2px solid #18181b;border-radius:12px}
.row{display:flex;gap:16px}.block,#accent{width:180px;height:120px;border-radius:8px;border:1px solid #a1a1aa}.block{background:#e4e4e7}#accent{background:#ef4444;border-color:#991b1b}
.line{margin-top:24px;width:592px;height:48px;background:linear-gradient(90deg,#18181b 0 33%,#71717a 33% 66%,#d4d4d8 66%)}
#secret-block{margin-top:12px;width:240px;height:24px;background:#fde68a}#secret-input{margin-top:8px;width:240px;height:28px}
</style></head><body><main id="fixture"><div class="row"><div class="block"></div><div id="accent"></div><div class="block"></div></div><div class="line"></div><div id="secret-block">SECRET TEXT</div><input id="secret-input" value="secret-token" /></main></body></html>`
}
