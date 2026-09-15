import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const repo = resolve(import.meta.dir, "../../..")
const sourceExtension = resolve(repo, "extensions/chrome")
const profile = await mkdtemp(join(tmpdir(), "opencode-snapeye-mv3-profile-"))
const extension = await mkdtemp(join(tmpdir(), "opencode-snapeye-mv3-extension-"))
const requireFromApp = createRequire(resolve(repo, "packages/app/package.json"))
const chromium = process.env.CHROMIUM_PATH ?? requireFromApp("@playwright/test").chromium.executablePath()

const fixture = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname !== "/fixture") return new Response("not found", { status: 404 })
    return new Response(fixtureHtml(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        // Production extension injection must not depend on the application's
        // script policy. Keep inline CSS for the motion fixture, but deny page
        // script/connect/object/frame execution entirely.
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'",
      },
    })
  },
})

try {
  await cp(sourceExtension, extension, { recursive: true })
  const manifest = JSON.parse(await readFile(join(extension, "manifest.json"), "utf8"))
  manifest.name = "OpenCode SnapEye MV3 Lifetime Harness"
  manifest.background = { service_worker: "harness-sw.js" }
  await writeFile(join(extension, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8")
  await writeFile(join(extension, "harness-sw.js"), harnessWorkerSource(), "utf8")
  await writeFile(join(extension, "runner.html"), `<!doctype html><meta charset="utf-8"><pre id="result">pending</pre><script src="runner.js"></script>`, "utf8")
  await writeFile(join(extension, "runner.js"), runnerSource(`http://127.0.0.1:${fixture.port}/fixture`), "utf8")

  const browser = Bun.spawn([
    chromium,
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    // Expose performance.memory with useful precision inside the fixture
    // renderer. This is development telemetry only; hard memory safety still
    // comes from SnapEye's frame/pixel ceilings plus host artifact budgets.
    "--enable-precise-memory-info",
    "about:blank",
  ], { stdout: "ignore", stderr: "pipe" })

  try {
    const port = await readDevtoolsPort(profile)
    const worker = await waitForTarget(port, (target) => target.type === "service_worker" && target.url.endsWith("/harness-sw.js"))
    const extensionId = new URL(worker.url).host
    const runner = await createTarget(port, `chrome-extension://${extensionId}/runner.html`)
    if (!runner.webSocketDebuggerUrl) throw new Error("MV3 runner did not expose a CDP websocket")
    const cdp = await Cdp.connect(runner.webSocketDebuggerUrl)
    try {
      await cdp.send("Runtime.enable")
      const deadline = Date.now() + 45_000
      let result: any = null
      let lastStatus = ""
      while (Date.now() < deadline) {
        const value = await evaluate(cdp, `document.querySelector('#result')?.textContent ?? ''`)
        if (typeof value === "string") lastStatus = value
        if (typeof value === "string" && value.startsWith("{")) {
          result = JSON.parse(value)
          break
        }
        await Bun.sleep(100)
      }
      if (!result) throw new Error(`Timed out waiting for MV3 certification result; last stage=${JSON.stringify(lastStatus)}`)
      if (!result.ok) throw new Error(`MV3 visual_record failed: ${JSON.stringify(result)}`)
      if (result.beforeBootId !== result.afterBootId) {
        throw new Error(`MV3 service worker restarted during visual_record: ${JSON.stringify(result)}`)
      }
      if (!(result.elapsedMs >= 14_000 && result.elapsedMs < 30_000)) {
        throw new Error(`MV3 visual_record lifetime was outside the expected window: ${JSON.stringify(result)}`)
      }
      if (!(result.frameCount >= 10)) throw new Error(`MV3 visual_record captured too few frames: ${JSON.stringify(result)}`)
      if (
        !Number.isFinite(result.recordRendererHeapBeforeBytes) ||
        !Number.isFinite(result.recordRendererHeapPeakBytes) ||
        !Number.isFinite(result.recordRendererHeapAfterBytes) ||
        !Number.isFinite(result.recordRendererHeapPeakDeltaBytes) ||
        !(result.recordRendererHeapPeakBytes > 0) ||
        !(result.recordRendererHeapPeakDeltaBytes >= 0)
      ) {
        throw new Error(`MV3 visual_record renderer heap telemetry was unavailable/invalid: ${JSON.stringify(result)}`)
      }
      if (!(result.artifactRpcCount >= 5) || result.resultCommits !== 1) {
        throw new Error(`MV3 artifact RPC did not complete normally: ${JSON.stringify(result)}`)
      }
      if (result.interruptResponseOk !== false || !(result.interruptElapsedMs < 5_000)) {
        throw new Error(`MV3 trusted-input interrupt did not promptly cancel visual_record: ${JSON.stringify(result)}`)
      }
      if (result.afterInterruptResultCommits !== 1) {
        throw new Error(`MV3 interrupted visual_record published a terminal result: ${JSON.stringify(result)}`)
      }
      if (result.interruptError?.tag !== "BrowserControlInterrupted") {
        throw new Error(`MV3 trusted-input interrupt used the wrong error taxonomy: ${JSON.stringify(result)}`)
      }
      if (result.afterFirstVisualInjects !== 1 || result.afterInterruptVisualInjects !== 1) {
        throw new Error(`MV3 warm visual operation reinjected the heavy runtime: ${JSON.stringify(result)}`)
      }
      if (result.navigationResponseOk !== false || result.navigationError?.tag !== "BrowserControlInterrupted" || !(result.navigationElapsedMs < 5_000)) {
        throw new Error(`MV3 navigation did not canonically interrupt visual_record: ${JSON.stringify(result)}`)
      }
      if (result.afterNavigationResultCommits !== 1) {
        throw new Error(`MV3 navigation-interrupted visual_record published a terminal result: ${JSON.stringify(result)}`)
      }
      if (result.closeResponseOk !== false || result.closeError?.tag !== "BrowserControlInterrupted" || !(result.closeElapsedMs < 5_000)) {
        throw new Error(`MV3 tab close did not canonically interrupt visual_record: ${JSON.stringify(result)}`)
      }
      if (result.afterCloseResultCommits !== 1) {
        throw new Error(`MV3 tab-close interrupted visual_record published a terminal result: ${JSON.stringify(result)}`)
      }
      if (result.afterCloseVisualInjects !== 2) {
        throw new Error(`MV3 navigation did not invalidate/reload the per-document visual runtime exactly once: ${JSON.stringify(result)}`)
      }
      if (
        result.concurrentCaptureOk !== true ||
        result.concurrentDiffOk !== true ||
        result.concurrentDiffChangedA !== false ||
        result.concurrentDiffChangedB !== false ||
        !Array.isArray(result.concurrentDiffSamplesMs) ||
        result.concurrentDiffSamplesMs.length !== 5 ||
        !(result.concurrentDiffMedianMs < 1_500) ||
        !(result.concurrentDiffP95Ms < 2_500)
      ) {
        throw new Error(`MV3 concurrent independent capture/diff certification failed: ${JSON.stringify(result)}`)
      }
      if (result.afterConcurrentResultCommits !== 13 || result.afterConcurrentVisualInjects !== 4) {
        throw new Error(`MV3 concurrent visual transactions had unexpected terminal/injection counts: ${JSON.stringify(result)}`)
      }
      if (
        result.refCaptureOk !== true ||
        result.staleRefResponseOk !== false ||
        result.staleRefErrorTag !== "BrowserStaleRefError" ||
        result.freshRefDiffOk !== true ||
        result.freshRefDiffChanged !== false
      ) {
        throw new Error(`MV3 versioned visual-ref targeting failed: ${JSON.stringify(result)}`)
      }
      if (
        result.afterRefResultCommits !== result.afterConcurrentResultCommits + 2 ||
        result.afterRefVisualInjects !== result.afterConcurrentVisualInjects
      ) {
        throw new Error(`MV3 ref targeting leaked a terminal result or reinjected the warm visual runtime: ${JSON.stringify(result)}`)
      }
      if (result.finalBootId !== result.beforeBootId) {
        throw new Error(`MV3 worker restarted during lifecycle interruption probes: ${JSON.stringify(result)}`)
      }
      console.log(JSON.stringify({
        ok: true,
        strictCspFixture: true,
        chromium,
        extensionId,
        ...result,
      }, null, 2))
    } finally {
      cdp.close()
    }
  } finally {
    browser.kill()
    await browser.exited.catch(() => undefined)
  }
} finally {
  fixture.stop(true)
  await rm(profile, { recursive: true, force: true }).catch(() => undefined)
  await rm(extension, { recursive: true, force: true }).catch(() => undefined)
}

function harnessWorkerSource() {
  return `
const bootId = crypto.randomUUID();
const nativeListeners = new Set();
const disconnectListeners = new Set();
let artifactRpcCount = 0;
let resultCommits = 0;
let writeSequence = 0;
let visualInjects = 0;
const writes = new Map();
const baselines = new Map();
const reads = new Map();
let readSequence = 0;

const nativePort = {
  onMessage: {
    addListener(listener) { nativeListeners.add(listener); },
    removeListener(listener) { nativeListeners.delete(listener); },
  },
  onDisconnect: {
    addListener(listener) { disconnectListeners.add(listener); },
    removeListener(listener) { disconnectListeners.delete(listener); },
  },
  postMessage(message) {
    if (!message || message.type !== 'artifact_rpc' || !message.request) return;
    artifactRpcCount += 1;
    const request = message.request;
    const payload = request.payload || {};
    let result = null;
    if (request.method === 'run_write_begin' || request.method === 'baseline_write_begin') {
      const writeId = 'w-' + (++writeSequence);
      const totalBytes = Number(payload.totalBytes || 0);
      writes.set(writeId, {
        kind: request.method === 'baseline_write_begin' ? 'baseline' : 'run',
        name: payload.name,
        meta: payload.meta || null,
        totalBytes,
        offset: 0,
        bytes: new Uint8Array(totalBytes),
      });
      result = { writeId, maxChunkBytes: 128 * 1024 };
    } else if (request.method === 'write_chunk') {
      const transfer = writes.get(payload.writeId);
      if (!transfer) throw new Error('unknown harness write');
      const binary = typeof payload.bytes === 'string' ? atob(payload.bytes) : '';
      const offset = Number(payload.offset || 0);
      if (offset !== transfer.offset) throw new Error('harness write offset mismatch');
      for (let index = 0; index < binary.length; index++) transfer.bytes[offset + index] = binary.charCodeAt(index);
      transfer.offset += binary.length;
      result = { offset: transfer.offset };
    } else if (request.method === 'write_commit') {
      const transfer = writes.get(payload.writeId);
      if (!transfer) throw new Error('unknown harness write commit');
      if (transfer.offset !== transfer.totalBytes) throw new Error('short harness write');
      if (transfer.kind === 'baseline') baselines.set(transfer.name, { image: transfer.bytes, meta: transfer.meta });
      writes.delete(payload.writeId);
      result = { committed: true };
    } else if (request.method === 'write_abort') {
      writes.delete(payload.writeId);
      result = { aborted: true };
    } else if (request.method === 'result_commit') {
      resultCommits += 1;
      result = payload.result;
    } else if (request.method === 'baseline_read_open') {
      const baseline = baselines.get(payload.name);
      if (baseline) {
        const readId = 'r-' + (++readSequence);
        reads.set(readId, baseline.image);
        result = { readId, byteLength: baseline.image.byteLength, meta: baseline.meta, maxChunkBytes: 128 * 1024 };
      }
    } else if (request.method === 'baseline_read_chunk') {
      const bytes = reads.get(payload.readId);
      if (!bytes) throw new Error('unknown harness read');
      const offset = Number(payload.offset || 0);
      const length = Number(payload.length || 0);
      const chunk = bytes.slice(offset, offset + length);
      let binary = '';
      const block = 0x8000;
      for (let start = 0; start < chunk.byteLength; start += block) {
        binary += String.fromCharCode(...chunk.subarray(start, Math.min(chunk.byteLength, start + block)));
      }
      result = { bytes: btoa(binary), byteLength: chunk.byteLength };
    } else if (request.method === 'baseline_read_close') {
      reads.delete(payload.readId);
      result = { closed: true };
    }
    const response = { ok: true, id: request.id, result };
    queueMicrotask(() => {
      for (const listener of [...nativeListeners]) listener({ type: 'artifact_rpc_result', response });
    });
  },
  disconnect() {},
};

try {
  Object.defineProperty(chrome.runtime, 'connectNative', { configurable: true, value: () => nativePort });
} catch {
  chrome.runtime.connectNative = () => nativePort;
}

const productionExecuteScript = chrome.scripting.executeScript.bind(chrome.scripting);
chrome.scripting.executeScript = async (details) => {
  if (Array.isArray(details?.files) && details.files.includes('src/content/visual.bundle.js')) visualInjects += 1;
  return productionExecuteScript(details);
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'opencode:mv3-harness-state') return;
  sendResponse({ bootId, artifactRpcCount, resultCommits, visualInjects });
  return false;
});

importScripts('src/background/sw.bundle.js');
`
}

function runnerSource(fixtureUrl: string) {
  return `
(async () => {
  const out = document.querySelector('#result');
  try {
    out.textContent = 'stage:setup';
    const before = await chrome.runtime.sendMessage({ type: 'opencode:mv3-harness-state' });
    const tab = await chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl)}, active: true });
    if (typeof tab.id !== 'number') throw new Error('fixture tab id missing');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const envelope = (requestId, targetTabId, operationName, runId, input) => ({
      type: 'opencode:request',
      request: {
        requestId,
        sessionId: 'ses-mv3',
        windowId: 'win-mv3',
        workspaceId: 'workspace-mv3',
        directory: 'C:/mv3-harness',
        messageId: 'msg-' + requestId,
        toolCallId: 'tool-' + requestId,
        tabId: String(targetTabId),
        timeoutMs: 30_000,
        operation: {
          name: operationName,
          input: { ...input,
            __opencodeVisual: {
              capability: 'cap-' + requestId,
              runId,
              maxChunkBytes: 128 * 1024,
              redaction: { blocks: [], attributes: [] },
            },
          },
        },
      },
    });
    const request = (requestId, runId, name) => envelope(requestId, tab.id, 'visual_record', runId, {
            name,
            target: { kind: 'css', selector: '#fixture' },
            duration: 15_000,
            fps: 1,
            scale: 0.5,
            format: 'gif',
            filmstripMaxCells: 12,
    });
    const visualRequest = (targetTabId, operationName, requestId, runId, name) => envelope(requestId, targetTabId, operationName, runId, {
      name,
      target: { kind: 'css', selector: '#fixture' },
    });
    const rendererHeap = async (targetTabId) => {
      const rows = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        world: 'ISOLATED',
        func: () => {
          const memory = performance.memory;
          if (!memory) return null;
          return {
            usedJSHeapSize: Number(memory.usedJSHeapSize),
            totalJSHeapSize: Number(memory.totalJSHeapSize),
            jsHeapSizeLimit: Number(memory.jsHeapSizeLimit),
          };
        },
      });
      return rows?.[0]?.result ?? null;
    };

    out.textContent = 'stage:15s-record';
    const started = performance.now();
    const recordRendererHeapBefore = await rendererHeap(tab.id);
    let recordSettled = false;
    const recordFlight = chrome.runtime.sendMessage(request('mv3-record-1', 'mv3_record_1', 'mv3-lifetime')).finally(() => { recordSettled = true; });
    const recordRendererHeapSamples = [];
    while (!recordSettled) {
      const sample = await rendererHeap(tab.id).catch(() => null);
      if (sample && Number.isFinite(sample.usedJSHeapSize)) recordRendererHeapSamples.push(sample.usedJSHeapSize);
      if (!recordSettled) await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const response = await recordFlight;
    const recordCompletedAt = performance.now();
    const recordRendererHeapAfter = await rendererHeap(tab.id);
    const elapsedMs = Math.round(recordCompletedAt - started);
    const recordRendererHeapBeforeBytes = Number(recordRendererHeapBefore?.usedJSHeapSize ?? 0);
    const recordRendererHeapAfterBytes = Number(recordRendererHeapAfter?.usedJSHeapSize ?? 0);
    const recordRendererHeapPeakBytes = Math.max(recordRendererHeapBeforeBytes, recordRendererHeapAfterBytes, ...recordRendererHeapSamples);
    const recordRendererHeapPeakDeltaBytes = Math.max(0, recordRendererHeapPeakBytes - recordRendererHeapBeforeBytes);
    const after = await chrome.runtime.sendMessage({ type: 'opencode:mv3-harness-state' });
    const visual = response?.result?.visual;

    // A trusted pointer event while recording represents either direct human
    // takeover or another concurrent browser actor. Both invalidate a
    // deterministic observation. Use chrome.debugger only in this test runner
    // to synthesize a browser-trusted event; production visual_record remains
    // debugger-free for CSS/document targets.
    out.textContent = 'stage:trusted-input-interrupt';
    const interruptStarted = performance.now();
    const interruptedPromise = chrome.runtime.sendMessage(request('mv3-record-interrupt', 'mv3_record_interrupt', 'mv3-interrupt'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    try {
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 10, button: 'left', clickCount: 1 });
      await chrome.debugger.sendCommand({ tabId: tab.id }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 10, button: 'left', clickCount: 1 });
    } finally {
      await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    }
    const interruptResponse = await interruptedPromise;
    const interruptElapsedMs = Math.round(performance.now() - interruptStarted);
    const afterInterrupt = await chrome.runtime.sendMessage({ type: 'opencode:mv3-harness-state' });

    out.textContent = 'stage:navigation-interrupt';
    const navigationStarted = performance.now();
    const navigationPromise = chrome.runtime.sendMessage(request('mv3-record-navigation', 'mv3_record_navigation', 'mv3-navigation'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await chrome.tabs.update(tab.id, { url: ${JSON.stringify(fixtureUrl + "?navigated=1")} });
    const navigationResponse = await navigationPromise;
    const navigationElapsedMs = Math.round(performance.now() - navigationStarted);
    const afterNavigation = await chrome.runtime.sendMessage({ type: 'opencode:mv3-harness-state' });

    const navDeadline = Date.now() + 10_000;
    while (Date.now() < navDeadline) {
      const current = await chrome.tabs.get(tab.id);
      if (current.status === 'complete') break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    out.textContent = 'stage:tab-close-interrupt';
    const closeStarted = performance.now();
    const closePromise = chrome.runtime.sendMessage(request('mv3-record-close', 'mv3_record_close', 'mv3-close'));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await chrome.tabs.remove(tab.id);
    const closeResponse = await closePromise;
    const closeElapsedMs = Math.round(performance.now() - closeStarted);
    const afterClose = await chrome.runtime.sendMessage({ type: 'opencode:mv3-harness-state' });

    // Two independent documents share one MV3 worker/native artifact channel.
    // Capture two baselines, then run five warm concurrent diff rounds. This is
    // deliberately multi-sample: background-tab timing regressions must not be
    // accepted/rejected from one scheduler observation.
    out.textContent = 'stage:concurrent-tabs';
    const concurrentA = await chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl + "?concurrent=a")}, active: false });
    const concurrentB = await chrome.tabs.create({ url: ${JSON.stringify(fixtureUrl + "?concurrent=b")}, active: false });
    if (typeof concurrentA.id !== 'number' || typeof concurrentB.id !== 'number') throw new Error('concurrent fixture tabs missing ids');
    for (const id of [concurrentA.id, concurrentB.id]) {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        if ((await chrome.tabs.get(id)).status === 'complete') break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    out.textContent = 'stage:concurrent-capture';
    const captures = await Promise.all([
      chrome.runtime.sendMessage(visualRequest(concurrentA.id, 'visual_capture', 'mv3-cap-a', 'mv3_cap_a', 'concurrent-a')),
      chrome.runtime.sendMessage(visualRequest(concurrentB.id, 'visual_capture', 'mv3-cap-b', 'mv3_cap_b', 'concurrent-b')),
    ]);
    out.textContent = 'stage:concurrent-diff';
    const concurrentDiffSamplesMs = [];
    let diffs = [];
    for (let round = 0; round < 5; round++) {
      const concurrentStarted = performance.now();
      diffs = await Promise.all([
        chrome.runtime.sendMessage(visualRequest(concurrentA.id, 'visual_diff', 'mv3-diff-a-' + round, 'mv3_diff_a_' + round, 'concurrent-a')),
        chrome.runtime.sendMessage(visualRequest(concurrentB.id, 'visual_diff', 'mv3-diff-b-' + round, 'mv3_diff_b_' + round, 'concurrent-b')),
      ]);
      concurrentDiffSamplesMs.push(Math.round(performance.now() - concurrentStarted));
      if (!diffs.every((value) => value?.ok === true && value?.result?.visual?.status === 'ok' && value?.result?.visual?.diff?.changed === false)) {
        throw new Error('concurrent warm diff round ' + round + ' failed: ' + JSON.stringify(diffs));
      }
    }
    const sortedConcurrentSamples = [...concurrentDiffSamplesMs].sort((a, b) => a - b);
    const concurrentDiffMedianMs = sortedConcurrentSamples[Math.floor(sortedConcurrentSamples.length / 2)];
    const concurrentDiffP95Ms = sortedConcurrentSamples[Math.ceil(sortedConcurrentSamples.length * 0.95) - 1];
    const afterConcurrent = await chrome.runtime.sendMessage({ type: 'opencode:mv3-harness-state' });

    // Exercise the SHIPPING service worker's snapshot -> versioned ref ->
    // SnapEye target canonicalization path. A stale ref must fail before the
    // visual runtime/artifact store runs, and the next fresh ref must still
    // work normally (proving stale-target cleanup did not poison the worker).
    out.textContent = 'stage:versioned-visual-ref';
    const refSnapshot1 = await chrome.runtime.sendMessage(envelope(
      'mv3-ref-snapshot-1', concurrentA.id, 'snapshot', 'unused_ref_snapshot_1', {}
    ));
    const refElement1 = refSnapshot1?.result?.snapshot?.elements?.[0];
    const refVersion1 = refSnapshot1?.result?.snapshot?.snapshotVersion;
    if (!refSnapshot1?.ok || !refElement1?.ref || !Number.isFinite(refVersion1)) {
      throw new Error('initial versioned snapshot did not produce a usable ref: ' + JSON.stringify(refSnapshot1));
    }
    const refCapture = await chrome.runtime.sendMessage(envelope(
      'mv3-ref-capture', concurrentA.id, 'visual_capture', 'mv3_ref_capture', {
        name: 'ref-target',
        target: { kind: 'element', target: { ref: refElement1.ref, snapshotVersion: refVersion1 } },
      }
    ));

    const refSnapshot2 = await chrome.runtime.sendMessage(envelope(
      'mv3-ref-snapshot-2', concurrentA.id, 'snapshot', 'unused_ref_snapshot_2', {}
    ));
    const refElement2 = refSnapshot2?.result?.snapshot?.elements?.[0];
    const refVersion2 = refSnapshot2?.result?.snapshot?.snapshotVersion;
    if (!refSnapshot2?.ok || !refElement2?.ref || !Number.isFinite(refVersion2) || refVersion2 === refVersion1) {
      throw new Error('replacement snapshot did not advance the ref epoch: ' + JSON.stringify(refSnapshot2));
    }
    const staleRefResponse = await chrome.runtime.sendMessage(envelope(
      'mv3-ref-stale', concurrentA.id, 'visual_diff', 'mv3_ref_stale', {
        name: 'ref-target',
        target: { kind: 'element', target: { ref: refElement1.ref, snapshotVersion: refVersion1 } },
      }
    ));
    const freshRefDiff = await chrome.runtime.sendMessage(envelope(
      'mv3-ref-fresh', concurrentA.id, 'visual_diff', 'mv3_ref_fresh', {
        name: 'ref-target',
        target: { kind: 'element', target: { ref: refElement2.ref, snapshotVersion: refVersion2 } },
      }
    ));
    const afterRef = await chrome.runtime.sendMessage({ type: 'opencode:mv3-harness-state' });

    out.textContent = JSON.stringify({
      ok: response?.ok === true && visual?.status === 'ok' && visual?.operation === 'record',
      beforeBootId: before?.bootId,
      afterBootId: after?.bootId,
      elapsedMs,
      frameCount: visual?.record?.frameCount ?? 0,
      durationActualMs: visual?.record?.durationActualMs ?? null,
      recordRendererHeapBeforeBytes,
      recordRendererHeapPeakBytes,
      recordRendererHeapAfterBytes,
      recordRendererHeapPeakDeltaBytes,
      recordRendererHeapSamples: recordRendererHeapSamples.length,
      artifactRpcCount: after?.artifactRpcCount ?? 0,
      resultCommits: after?.resultCommits ?? 0,
      afterFirstVisualInjects: after?.visualInjects ?? 0,
      artifacts: visual?.artifacts ?? null,
      error: response?.ok === false ? response?.error : null,
      interruptResponseOk: interruptResponse?.ok ?? null,
      interruptElapsedMs,
      afterInterruptResultCommits: afterInterrupt?.resultCommits ?? 0,
      afterInterruptVisualInjects: afterInterrupt?.visualInjects ?? 0,
      interruptError: interruptResponse?.ok === false ? interruptResponse?.error : null,
      navigationResponseOk: navigationResponse?.ok ?? null,
      navigationElapsedMs,
      navigationError: navigationResponse?.ok === false ? navigationResponse?.error : null,
      afterNavigationResultCommits: afterNavigation?.resultCommits ?? 0,
      afterNavigationVisualInjects: afterNavigation?.visualInjects ?? 0,
      closeResponseOk: closeResponse?.ok ?? null,
      closeElapsedMs,
      closeError: closeResponse?.ok === false ? closeResponse?.error : null,
      afterCloseResultCommits: afterClose?.resultCommits ?? 0,
      afterCloseVisualInjects: afterClose?.visualInjects ?? 0,
      concurrentCaptureOk: captures.every((value) => value?.ok === true && value?.result?.visual?.status === 'ok'),
      concurrentDiffOk: diffs.every((value) => value?.ok === true && value?.result?.visual?.status === 'ok'),
      concurrentDiffChangedA: diffs[0]?.result?.visual?.diff?.changed ?? null,
      concurrentDiffChangedB: diffs[1]?.result?.visual?.diff?.changed ?? null,
      concurrentDiffSamplesMs,
      concurrentDiffMedianMs,
      concurrentDiffP95Ms,
      afterConcurrentResultCommits: afterConcurrent?.resultCommits ?? 0,
      afterConcurrentVisualInjects: afterConcurrent?.visualInjects ?? 0,
      refCaptureOk: refCapture?.ok === true && refCapture?.result?.visual?.status === 'ok',
      staleRefResponseOk: staleRefResponse?.ok ?? null,
      staleRefErrorTag: staleRefResponse?.ok === false ? staleRefResponse?.error?.tag ?? null : null,
      freshRefDiffOk: freshRefDiff?.ok === true && freshRefDiff?.result?.visual?.status === 'ok',
      freshRefDiffChanged: freshRefDiff?.result?.visual?.diff?.changed ?? null,
      afterRefResultCommits: afterRef?.resultCommits ?? 0,
      afterRefVisualInjects: afterRef?.visualInjects ?? 0,
      finalBootId: afterRef?.bootId,
    });
  } catch (error) {
    out.textContent = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
})();
`
}

function fixtureHtml() {
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: white; }
  #fixture { width: 320px; height: 180px; overflow: hidden; background: #f4f4f5; position: relative; }
  #accent { position: absolute; width: 64px; height: 64px; left: 24px; top: 58px; background: #ef4444; animation: move 1s linear infinite alternate; }
  #visual-target { position: absolute; right: 12px; bottom: 12px; width: 88px; height: 32px; }
  @keyframes move { to { transform: translateX(180px); background: #2563eb; } }
</style>
<div id="fixture"><div id="accent"></div><button id="visual-target" type="button">Save</button></div>`
}

async function readDevtoolsPort(directory: string): Promise<number> {
  const file = join(directory, "DevToolsActivePort")
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    try {
      const port = Number.parseInt((await readFile(file, "utf8")).split(/\r?\n/, 1)[0] ?? "", 10)
      if (Number.isFinite(port) && port > 0) return port
    } catch {}
    await Bun.sleep(25)
  }
  throw new Error("Timed out waiting for Chromium DevToolsActivePort")
}

type Target = { type: string; url: string; webSocketDebuggerUrl?: string }

async function waitForTarget(port: number, predicate: (target: Target) => boolean): Promise<Target> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json() as Promise<Target[]>)
    const target = targets.find(predicate)
    if (target) return target
    await Bun.sleep(50)
  }
  throw new Error("Timed out waiting for MV3 service-worker target")
}

async function createTarget(port: number, url: string): Promise<Target> {
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  if (!response.ok) throw new Error(`Failed to create MV3 runner target: HTTP ${response.status}`)
  return response.json() as Promise<Target>
}

async function evaluate(cdp: Cdp, expression: string): Promise<any> {
  const response = await cdp.send<any>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime.evaluate failed")
  return response.result?.value
}

class Cdp {
  private sequence = 0
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()

  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => this.onMessage(String(event.data)))
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolveOpen, reject) => {
      socket.addEventListener("open", () => resolveOpen(), { once: true })
      socket.addEventListener("error", () => reject(new Error("MV3 CDP websocket failed to open")), { once: true })
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

  close() {
    for (const flight of this.pending.values()) flight.reject(new Error("MV3 CDP connection closed"))
    this.pending.clear()
    this.socket.close()
  }

  private onMessage(raw: string) {
    const message = JSON.parse(raw)
    if (typeof message.id !== "number") return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(`${message.error.message} (${message.error.code})`))
    else pending.resolve(message.result)
  }
}
