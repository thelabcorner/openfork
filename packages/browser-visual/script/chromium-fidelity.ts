import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const chrome = process.env.CHROME_PATH ?? (process.platform === "win32"
  ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  : process.platform === "darwin"
    ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    : "google-chrome")

const profile = await mkdtemp(join(tmpdir(), "opencode-snapeye-chromium-"))
const fixture = Bun.serve({
  port: 0,
  fetch(request) {
    const url = new URL(request.url)
    if (url.pathname === "/iframe") {
      return new Response(iframeHtml(url.searchParams.get("kind") ?? "frame"), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
      })
    }
    if (url.pathname !== "/fixture") return new Response("not found", { status: 404 })
    return new Response(fixtureHtml(url.port), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
  },
})

const browser = Bun.spawn([
  chrome,
  "--headless=new",
  "--remote-debugging-port=0",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "about:blank",
], { stdout: "ignore", stderr: "pipe" })

try {
  const port = await readDevtoolsPort(profile)
  const targets = await waitForJson<{ type: string; webSocketDebuggerUrl?: string }[]>(`http://127.0.0.1:${port}/json/list`)
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)
  if (!page?.webSocketDebuggerUrl) throw new Error("Chrome did not expose a page CDP target")

  const cdp = await Cdp.connect(page.webSocketDebuggerUrl)
  try {
    await cdp.send("Page.enable")
    await cdp.send("Runtime.enable")
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false })
    const loaded = cdp.once("Page.loadEventFired")
    await cdp.send("Page.navigate", { url: `http://127.0.0.1:${fixture.port}/fixture` })
    await loaded

    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "../test/chromium-harness-entry.ts")],
      target: "browser",
      format: "iife",
      minify: true,
      sourcemap: "none",
      plugins: [{
        name: "opencode-safe-gifenc",
        setup(build) {
          build.onResolve({ filter: /^gifenc$/ }, () => ({
            path: resolve(import.meta.dir, "../src/gifenc-safe.ts"),
          }))
        },
      }],
    })
    if (!build.success || build.outputs.length !== 1) {
      throw new Error(`Failed to build Chromium fidelity harness: ${build.logs.map(String).join("\n")}`)
    }
    const source = await build.outputs[0]!.text()

    const frameTree = await cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")
    const isolated = await cdp.send<{ executionContextId: number }>("Page.createIsolatedWorld", {
      frameId: frameTree.frameTree.frame.id,
      worldName: "opencode-snapeye-fidelity",
      grantUniveralAccess: false,
    })

    await evaluate(cdp, source)
    await evaluate(cdp, source, isolated.executionContextId)

    // Populate page features that are deliberately awkward for DOM snapshot
    // engines before the cross-world byte-identity proof: open Shadow DOM,
    // reflected form state, SVG, transforms and overflow/shadow bleed.
    await evaluate(cdp, `
      const host = document.querySelector('#shadow-host');
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<style>.shadow-card{width:96px;height:28px;background:#0ea5e9;color:white;padding:5px;font:12px Arial}</style><div class="shadow-card">shadow-dom</div>';
      const form = document.querySelector('#stateful-input');
      form.value = 'live-form-state';
      form.checked = true;
    `)

    const mainCapture = await call(cdp, undefined, "capture", ["cross-world", "#fixture"])
    await call(cdp, isolated.executionContextId, "importBaseline", ["cross-world", mainCapture.baseline])
    const isolatedAgainstMain = await call(cdp, isolated.executionContextId, "diff", ["cross-world", "#fixture"])
    assertUnchanged(isolatedAgainstMain.result, "main-world baseline -> isolated-world diff")

    const isolatedCapture = await call(cdp, isolated.executionContextId, "capture", ["isolated-origin", "#fixture"])
    await call(cdp, undefined, "importBaseline", ["isolated-origin", isolatedCapture.baseline])
    const mainAgainstIsolated = await call(cdp, undefined, "diff", ["isolated-origin", "#fixture"])
    assertUnchanged(mainAgainstIsolated.result, "isolated-world baseline -> main-world diff")

    const mainHash = sha256(mainCapture.baseline.image)
    const isolatedHash = sha256(isolatedCapture.baseline.image)

    await evaluate(cdp, `document.querySelector('#accent').style.background='#0066ff'`)
    const changed = await call(cdp, isolated.executionContextId, "diff", ["cross-world", "#fixture"])
    assertChanged(changed.result, "isolated-world mutation detection")

    // Redaction is a capture semantic, not an image post-process. Mutations in
    // hidden blocks and reflected input values must disappear from both the
    // baseline and current render, while an unredacted mutation must remain
    // observable.
    await evaluate(cdp, `document.querySelector('#accent').style.background='#ef4444'`)
    const redaction = {
      blocks: ["#secret-block"],
      attributes: [{ selector: "#secret-input", names: ["value"] }],
    }
    await call(cdp, isolated.executionContextId, "capture", ["redacted", "#fixture", redaction])
    await evaluate(cdp, `
      document.querySelector('#secret-block').textContent = 'CHANGED SECRET';
      document.querySelector('#secret-block').style.background = '#000';
      const input = document.querySelector('#secret-input');
      input.value = 'changed-token';
      input.setAttribute('value', 'changed-token');
    `)
    const redactedUnchanged = await call(cdp, isolated.executionContextId, "diff", ["redacted", "#fixture", redaction])
    assertUnchanged(redactedUnchanged.result, "redacted mutations")
    await evaluate(cdp, `document.querySelector('#accent').style.background='#0066ff'`)
    const redactedVisibleChange = await call(cdp, isolated.executionContextId, "diff", ["redacted", "#fixture", redaction])
    assertChanged(redactedVisibleChange.result, "unredacted mutation with redaction enabled")

    // Infinite animation must not create false-positive visual diffs for
    // capture/diff. Each operation freezes motion before SnapDOM serialization.
    await call(cdp, isolated.executionContextId, "capture", ["animation-stable", "#animation-fixture"])
    await Bun.sleep(420)
    const animationStable = await call(cdp, isolated.executionContextId, "diff", ["animation-stable", "#animation-fixture"])
    assertUnchanged(animationStable.result, "infinite CSS animation stabilization")

    // Hydration that lands shortly after the tool starts should become part of
    // the baseline rather than producing a cold-start false positive later.
    await evaluate(cdp, `
      const hydration = document.querySelector('#hydration-fixture');
      hydration.textContent = 'server';
      hydration.dataset.phase = 'server';
      hydration.style.height = '54px';
      setTimeout(() => { hydration.textContent = 'hydrating'; hydration.dataset.phase = 'one'; hydration.style.height = '68px'; }, 45);
      setTimeout(() => { hydration.textContent = 'hydrated'; hydration.dataset.phase = 'done'; hydration.style.height = '82px'; hydration.style.background = '#dcfce7'; }, 110);
    `)
    const hydrationCapture = await call(cdp, isolated.executionContextId, "capture", ["hydration-stable", "#hydration-fixture"])
    await Bun.sleep(220)
    const hydrationStable = await call(cdp, isolated.executionContextId, "diff", ["hydration-stable", "#hydration-fixture"])
    assertUnchanged(hydrationStable.result, "cold hydration settling")

    // Paint-only hydration is outside the geometry settle detector by design.
    // The public readiness selector is the deterministic contract for that
    // class of application work.
    await evaluate(cdp, `
      const paint = document.querySelector('#paint-hydration-fixture');
      paint.textContent = 'server';
      paint.style.background = '#fee2e2';
      document.querySelector('#hydration-ready')?.remove();
      setTimeout(() => {
        paint.textContent = 'paint-ready';
        paint.style.background = '#dbeafe';
        const marker = document.createElement('span');
        marker.id = 'hydration-ready';
        marker.hidden = true;
        document.body.appendChild(marker);
      }, 110);
    `)
    const paintHydrationCapture = await call(cdp, isolated.executionContextId, "capture", [
      "paint-hydration-ready",
      "#paint-hydration-fixture",
      {},
      { waitFor: "#hydration-ready", waitTimeout: 1000 },
    ])
    const paintHydrationStable = await call(cdp, isolated.executionContextId, "diff", [
      "paint-hydration-ready",
      "#paint-hydration-fixture",
      {},
      { waitFor: "#hydration-ready", waitTimeout: 1000 },
    ])
    assertUnchanged(paintHydrationStable.result, "paint-only hydration explicit readiness")

    // CSSOM edits do not create DOM mutation records. The OpenCode adapter
    // forces SnapDOM invalidation so a stylesheet-rule-only change must still be
    // visible to a later diff.
    await call(cdp, isolated.executionContextId, "capture", ["cssom-change", "#cssom-fixture"])
    await evaluate(cdp, `
      const sheet = [...document.styleSheets].find((candidate) => candidate.ownerNode?.id === 'fixture-styles');
      const rule = [...sheet.cssRules].find((candidate) => candidate.selectorText === '#cssom-fixture');
      rule.style.background = '#7c3aed';
    `)
    const cssomChanged = await call(cdp, isolated.executionContextId, "diff", ["cssom-change", "#cssom-fixture"])
    assertChanged(cssomChanged.result, "CSSOM-only mutation")

    // A hostile application may define globals with our names or monkey-patch
    // MAIN-world DOM prototypes. Isolated-world execution must remain insulated.
    await call(cdp, isolated.executionContextId, "capture", ["hostile-main", "#hostile-fixture"])
    await evaluate(cdp, `
      window.snapeye = new Proxy({}, { get() { throw new Error('hostile page snapeye'); } });
      window.__opencodeVisualRuntimeV1 = { run() { throw new Error('hostile page runtime'); } };
      Element.prototype.matches = function(){ throw new Error('hostile MAIN matches'); };
      Element.prototype.querySelectorAll = function(){ throw new Error('hostile MAIN querySelectorAll'); };
    `)
    const hostileStable = await call(cdp, isolated.executionContextId, "diff", ["hostile-main", "#hostile-fixture"])
    assertUnchanged(hostileStable.result, "hostile MAIN-world globals/prototypes")

    // DPR changes are baseline-affecting, but repeated operations in the same
    // DPR environment must remain deterministic and report the effective scale.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 2, mobile: false })
    const highDprCapture = await call(cdp, isolated.executionContextId, "capture", ["high-dpr", "#dpr-fixture"])
    const highDprStable = await call(cdp, isolated.executionContextId, "diff", ["high-dpr", "#dpr-fixture"])
    assertUnchanged(highDprStable.result, "high-DPR repeated capture")
    if (
      Number(highDprCapture.result?.image?.scale) !== 1 ||
      Number(highDprCapture.result?.image?.pixelWidth) !== Number(highDprCapture.result?.image?.cssWidth) ||
      Number(highDprCapture.result?.image?.pixelHeight) !== Number(highDprCapture.result?.image?.cssHeight)
    ) {
      throw new Error(`high-DPR host escaped SnapEye's deterministic DPR=1 raster contract: ${JSON.stringify(highDprCapture.result)}`)
    }
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false })

    // Canvas is copied as pixels rather than DOM. Prove both a normal 2D canvas
    // and a static WebGL buffer survive SnapDOM capture and that later pixel
    // mutations are observable. preserveDrawingBuffer is deliberate: the test
    // certifies stable static WebGL snapshots, not arbitrary continuously
    // redrawn GPU surfaces.
    await evaluate(cdp, `{
      const canvas = document.querySelector('#canvas-2d');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1d4ed8'; ctx.fillRect(0, 0, 120, 60);
      ctx.fillStyle = '#ffffff'; ctx.fillRect(16, 14, 42, 30);
      const glCanvas = document.querySelector('#canvas-webgl');
      const gl = glCanvas.getContext('webgl', { preserveDrawingBuffer: true });
      if (gl) { gl.clearColor(0.55, 0.15, 0.75, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    }`)
    await call(cdp, isolated.executionContextId, "capture", ["canvas-static", "#canvas-fixture"])
    const canvasStable = await call(cdp, isolated.executionContextId, "diff", ["canvas-static", "#canvas-fixture"])
    assertUnchanged(canvasStable.result, "static canvas/WebGL")
    await evaluate(cdp, `{
      const canvas = document.querySelector('#canvas-2d');
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#16a34a'; ctx.fillRect(0, 0, 120, 60);
      const gl = document.querySelector('#canvas-webgl').getContext('webgl', { preserveDrawingBuffer: true });
      if (gl) { gl.clearColor(0.05, 0.75, 0.35, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
    }`)
    const canvasChanged = await call(cdp, isolated.executionContextId, "diff", ["canvas-static", "#canvas-fixture"])
    assertChanged(canvasChanged.result, "canvas/WebGL pixel mutation")

    // Iframes are browser-owned nested documents. Capture the pair unchanged,
    // then mutate only the same-origin interior. If SnapDOM observes the nested
    // document it must report the mutation; the cross-origin frame is treated
    // as an opaque visual surface and is never introspected by OpenCode.
    await call(cdp, isolated.executionContextId, "capture", ["iframes", "#iframe-fixture"])
    const iframeStable = await call(cdp, isolated.executionContextId, "diff", ["iframes", "#iframe-fixture"])
    assertUnchanged(iframeStable.result, "same/cross-origin iframe repeated capture")
    await evaluate(cdp, `{
      const frame = document.querySelector('#same-frame');
      const doc = frame.contentDocument;
      if (doc?.body) { doc.body.textContent = 'same-origin-mutated'; doc.body.style.background = '#bbf7d0'; }
    }`)
    const iframeMutation = await call(cdp, isolated.executionContextId, "diff", ["iframes", "#iframe-fixture"])
    const sameOriginIframeMutationDetected = iframeMutation.result?.diff?.changed === true

    // Late image decode is paint-only, so use the same explicit readiness
    // contract required for paint-only hydration. The image itself is served as
    // a data URL to keep the gate hermetic and network-independent.
    await evaluate(cdp, `{
      document.querySelector('#media-ready')?.remove();
      const image = document.querySelector('#late-image');
      image.removeAttribute('src');
      setTimeout(() => {
        image.onload = () => {
          const marker = document.createElement('span');
          marker.id = 'media-ready'; marker.hidden = true; document.body.appendChild(marker);
        };
        image.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="72"><rect width="180" height="72" fill="#0f766e"/><circle cx="42" cy="36" r="22" fill="#f0fdfa"/><text x="78" y="43" font-family="Arial" font-size="18" fill="white">ready</text></svg>');
      }, 90);
    }`)
    const mediaCapture = await call(cdp, isolated.executionContextId, "capture", [
      "late-media",
      "#media-fixture",
      {},
      { waitFor: "#media-ready", waitTimeout: 1500 },
    ])
    const mediaStable = await call(cdp, isolated.executionContextId, "diff", [
      "late-media",
      "#media-fixture",
      {},
      { waitFor: "#media-ready", waitTimeout: 1500 },
    ])
    assertUnchanged(mediaStable.result, "late image explicit readiness")

    // FontFace readiness uses the same explicit application signal. A local
    // source keeps the gate hermetic while still exercising late font loading,
    // document.fonts registration, style invalidation and SnapDOM font state.
    await evaluate(cdp, `{
      document.querySelector('#font-ready')?.remove();
      const target = document.querySelector('#font-fixture');
      target.style.fontFamily = 'Arial, sans-serif';
      setTimeout(async () => {
        const face = new FontFace('LateFixtureFont', 'local("Arial")');
        await face.load();
        document.fonts.add(face);
        target.style.fontFamily = 'LateFixtureFont, Arial, sans-serif';
        const marker = document.createElement('span');
        marker.id = 'font-ready'; marker.hidden = true; document.body.appendChild(marker);
      }, 90);
    }`)
    const fontCapture = await call(cdp, isolated.executionContextId, "capture", [
      "late-font",
      "#font-fixture",
      {},
      { waitFor: "#font-ready", waitTimeout: 1500 },
    ])
    const fontStable = await call(cdp, isolated.executionContextId, "diff", [
      "late-font",
      "#font-fixture",
      {},
      { waitFor: "#font-ready", waitTimeout: 1500 },
    ])
    assertUnchanged(fontStable.result, "late FontFace explicit readiness")

    // Bounded high-entropy DOM: large enough to exercise cloning/serialization
    // and cache invalidation, but intentionally below pathological OOM territory.
    await evaluate(cdp, `{
      const large = document.querySelector('#large-fixture');
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 4000; i++) {
        const span = document.createElement('span');
        span.className = 'large-cell';
        span.textContent = String(i % 100);
        fragment.appendChild(span);
      }
      large.replaceChildren(fragment);
    }`)
    const largeCapture = await call(cdp, isolated.executionContextId, "capture", ["large-dom", "#large-fixture"])
    const largeStable = await call(cdp, isolated.executionContextId, "diff", ["large-dom", "#large-fixture"])
    assertUnchanged(largeStable.result, "bounded large DOM")

    // Large vector target: thousands of SVG nodes make current.svg materially
    // larger than normal UI snapshots and exercise serialization without
    // approaching the host's 64 MiB hard artifact ceiling.
    await evaluate(cdp, `{
      const svg = document.querySelector('#large-svg-fixture');
      const ns = 'http://www.w3.org/2000/svg';
      const fragment = document.createDocumentFragment();
      for (let i = 0; i < 2200; i++) {
        const rect = document.createElementNS(ns, 'rect');
        rect.setAttribute('x', String((i * 13) % 620));
        rect.setAttribute('y', String((i * 7) % 360));
        rect.setAttribute('width', String(4 + (i % 11)));
        rect.setAttribute('height', String(3 + (i % 9)));
        rect.setAttribute('fill', 'hsl(' + (i % 360) + ' 70% 55%)');
        fragment.appendChild(rect);
      }
      svg.replaceChildren(fragment);
    }`)
    const largeSvgCapture = await call(cdp, isolated.executionContextId, "capture", ["large-svg", "#large-svg-fixture"])
    const largeSvgStable = await call(cdp, isolated.executionContextId, "diff", ["large-svg", "#large-svg-fixture"])
    assertUnchanged(largeSvgStable.result, "bounded large SVG")

    // Imperative canvas/WebGL animation is not governed by CSS animation
    // stabilization. Motion is the subject, so certify it through record rather
    // than manufacturing a false capture/diff determinism guarantee.
    await evaluate(cdp, `{
      let tick = 0;
      const canvas = document.querySelector('#canvas-2d');
      const ctx = canvas.getContext('2d');
      const gl = document.querySelector('#canvas-webgl').getContext('webgl', { preserveDrawingBuffer: true });
      window.__opencodeCanvasMotion = setInterval(() => {
        tick += 1;
        ctx.fillStyle = tick % 2 ? '#dc2626' : '#2563eb';
        ctx.fillRect(0, 0, 120, 60);
        ctx.fillStyle = '#fff';
        ctx.fillRect((tick * 9) % 90, 18, 24, 24);
        if (gl) {
          const phase = (tick % 10) / 10;
          gl.clearColor(phase, 0.25, 1 - phase, 1);
          gl.clear(gl.COLOR_BUFFER_BIT);
        }
      }, 30);
    }`)
    const canvasRecorded = await call(cdp, isolated.executionContextId, "record", [
      "canvas-motion",
      "#canvas-fixture",
      { duration: 320, fps: 6, format: "gif", scale: 1 },
    ])
    assertRecorded(canvasRecorded.result, canvasRecorded.artifactNames, false, canvasRecorded.gifDecode)
    await evaluate(cdp, `clearInterval(window.__opencodeCanvasMotion); delete window.__opencodeCanvasMotion`)

    // Motion recording uses the same target/redaction kernel but intentionally
    // does not stabilize animations. Keep the proof short while still forcing
    // multiple frames and the bounded filmstrip + GIF encoders.
    await evaluate(cdp, `
      document.querySelector('#accent').style.background='#ef4444';
      document.querySelector('#accent').animate(
        [{ transform: 'translateX(0px)' }, { transform: 'translateX(24px)' }],
        { duration: 240, iterations: Infinity, direction: 'alternate' }
      );
    `)
    const recorded = await call(cdp, isolated.executionContextId, "record", [
      "motion",
      "#fixture",
      { duration: 300, fps: 6, format: "both", scale: 1 },
    ])
    assertRecorded(recorded.result, recorded.artifactNames, true, recorded.gifDecode)

    // The public record ceiling is 15s. Cancellation must not merely mark the
    // request and then wait out that entire collection window: the adapter's
    // abort-aware SnapEye clock should unwind between frames and must prevent a
    // post-abort terminal result/artifact publication.
    const abortedRecord = await call(cdp, isolated.executionContextId, "recordAbort", [
      "motion-abort",
      "#fixture",
      { duration: 15_000, fps: 10, format: "gif", scale: 1 },
      150,
    ])
    assertAbortedRecord(abortedRecord)

    console.log(JSON.stringify({
      ok: true,
      chrome,
      crossWorldUnchanged: true,
      reverseCrossWorldUnchanged: true,
      exactPngBytesEqual: mainHash === isolatedHash,
      mainBaselineSha256: mainHash,
      isolatedBaselineSha256: isolatedHash,
      mutationChangedRatio: changed.result?.diff?.changedRatio ?? null,
      mutationRegionCount: changed.result?.diff?.regionCount ?? changed.result?.regions?.length ?? null,
      redactionHiddenMutationsUnchanged: true,
      redactionVisibleMutationDetected: true,
      animationStabilizationUnchanged: true,
      hydrationSettlingUnchanged: true,
      hydrationCaptureMs: hydrationCapture.result?.timing?.captureMs ?? null,
      paintHydrationExplicitReadyUnchanged: true,
      paintHydrationCaptureMs: paintHydrationCapture.result?.timing?.captureMs ?? null,
      cssomOnlyMutationDetected: true,
      hostileMainWorldUnchanged: true,
      highDprUnchanged: true,
      highDprForcedScale: highDprCapture.result?.image?.scale ?? null,
      staticCanvasWebglUnchanged: true,
      canvasWebglMutationDetected: true,
      iframeRepeatedCaptureUnchanged: true,
      sameOriginIframeMutationDetected,
      crossOriginIframePolicy: "opaque-no-introspection",
      lateImageExplicitReadyUnchanged: true,
      lateImageCaptureMs: mediaCapture.result?.timing?.captureMs ?? null,
      lateFontExplicitReadyUnchanged: true,
      lateFontCaptureMs: fontCapture.result?.timing?.captureMs ?? null,
      largeDomNodes: 4000,
      largeDomCaptureMs: largeCapture.result?.timing?.captureMs ?? null,
      largeSvgNodes: 2200,
      largeSvgCaptureMs: largeSvgCapture.result?.timing?.captureMs ?? null,
      animatedCanvasWebglRecordFrames: canvasRecorded.result?.record?.frameCount ?? null,
      animatedCanvasWebglGifDecodedFrames: canvasRecorded.gifDecode?.decodedFrames ?? null,
      visualRecordFrames: recorded.result?.record?.frameCount ?? null,
      visualRecordGifDecodedFrames: recorded.gifDecode?.decodedFrames ?? null,
      visualRecordArtifacts: recorded.artifactNames,
      visualRecordAbortElapsedMs: abortedRecord.elapsedMs,
      visualRecordAbortPublishedTerminal: abortedRecord.terminalCommitted,
      mainArtifacts: mainCapture.artifactNames,
      isolatedArtifacts: isolatedCapture.artifactNames,
      harnessBundleBytes: Buffer.byteLength(source),
    }, null, 2))
  } finally {
    cdp.close()
  }
} finally {
  fixture.stop(true)
  browser.kill()
  await browser.exited.catch(() => undefined)
  await rm(profile, { recursive: true, force: true }).catch(() => undefined)
}

function assertUnchanged(result: any, label: string) {
  if (result?.status !== "ok" || result?.operation !== "diff" || result?.diff?.changed !== false) {
    throw new Error(`${label} was not unchanged: ${JSON.stringify(result)}`)
  }
}

function assertChanged(result: any, label: string) {
  if (result?.status !== "ok" || result?.operation !== "diff" || result?.diff?.changed !== true) {
    throw new Error(`${label} did not detect a change: ${JSON.stringify(result)}`)
  }
  if (!(Number(result.diff.changedRatio) > 0)) throw new Error(`${label} returned a non-positive changedRatio`)
}

function assertRecorded(
  result: any,
  artifactNames: string[],
  requireVideo = false,
  gifDecode?: { frameCount?: number; decodedFrames?: number; width?: number; height?: number } | null,
) {
  if (result?.status !== "ok" || result?.operation !== "record") {
    throw new Error(`visual record failed: ${JSON.stringify(result)}`)
  }
  const recordedFrames = Number(result.record?.frameCount)
  if (!(recordedFrames >= 2)) throw new Error("visual record produced fewer than two frames")
  if (!artifactNames.includes("frames.png") || !artifactNames.includes("recording.gif")) {
    throw new Error(`visual record missed expected artifacts: ${JSON.stringify(artifactNames)}`)
  }
  if (!gifDecode || gifDecode.frameCount !== recordedFrames || gifDecode.decodedFrames !== recordedFrames) {
    throw new Error(`Chromium did not decode every generated GIF frame: ${JSON.stringify({ recordedFrames, gifDecode })}`)
  }
  if (!(Number(gifDecode.width) > 0) || !(Number(gifDecode.height) > 0)) {
    throw new Error(`Chromium decoded invalid GIF dimensions: ${JSON.stringify(gifDecode)}`)
  }
  if (requireVideo && !artifactNames.some((name) => name === "recording.webm" || name === "recording.mp4")) {
    throw new Error(`visual record missed expected video artifact: ${JSON.stringify(artifactNames)}`)
  }
}

function assertAbortedRecord(value: any) {
  if (value?.outcome !== "rejected") throw new Error(`15s visual record did not reject after abort: ${JSON.stringify(value)}`)
  if (!(Number(value.elapsedMs) >= 0 && Number(value.elapsedMs) < 5_000)) {
    throw new Error(`15s visual record abort was not prompt: ${JSON.stringify(value)}`)
  }
  if (value.terminalCommitted !== false || (Array.isArray(value.artifactNames) && value.artifactNames.length > 0)) {
    throw new Error(`aborted visual record published terminal state/artifacts: ${JSON.stringify(value)}`)
  }
}

function sha256(base64: string) {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex")
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

async function evaluate(cdp: Cdp, expression: string, contextId?: number): Promise<any> {
  const response = await cdp.send<any>("Runtime.evaluate", {
    expression,
    ...(contextId !== undefined ? { contextId } : {}),
    awaitPromise: true,
    returnByValue: true,
  })
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "Runtime.evaluate failed"
    const preview = expression.replace(/\s+/g, " ").slice(0, 240)
    throw new Error(`${description}; expression=${preview}`)
  }
  return response.result?.value
}

async function call(cdp: Cdp, contextId: number | undefined, method: string, args: unknown[]): Promise<any> {
  return evaluate(
    cdp,
    `globalThis.__opencodeSnapEyeHarness.${method}(...${JSON.stringify(args)})`,
    contextId,
  )
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

function fixtureHtml(port: string) {
  const crossFrame = `http://localhost:${port}/iframe?kind=cross`
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style id="fixture-styles">
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 800px; min-height: 2600px; background: #f7f7f5; }
  body { padding: 32px; font-family: Arial, sans-serif; }
  #fixture { width: 640px; height: 360px; padding: 24px; background: #ffffff; border: 2px solid #18181b; border-radius: 12px; }
  .row { display: flex; gap: 16px; align-items: center; }
  .block { width: 180px; height: 120px; border-radius: 8px; background: #e4e4e7; border: 1px solid #a1a1aa; }
  #accent { width: 180px; height: 120px; border-radius: 8px; background: #ef4444; border: 1px solid #991b1b; }
  .line { margin-top: 24px; width: 592px; height: 48px; background: linear-gradient(90deg, #18181b 0 33%, #71717a 33% 66%, #d4d4d8 66%); }
  #secret-block { margin-top: 12px; width: 240px; height: 24px; background: #fde68a; }
  #secret-input { margin-top: 8px; width: 240px; height: 28px; }
  .feature-row { display: flex; gap: 12px; margin-top: 14px; align-items: center; }
  #shadow-host { width: 100px; min-height: 32px; }
  #bleed { width: 90px; height: 34px; background: #f97316; transform: rotate(-3deg) translateX(3px); box-shadow: 9px 7px 5px rgba(0,0,0,.18); overflow: visible; }
  #animation-fixture, #hydration-fixture, #paint-hydration-fixture, #cssom-fixture, #hostile-fixture, #dpr-fixture { margin-top: 14px; width: 280px; height: 54px; padding: 8px; border: 1px solid #71717a; background: #ffffff; overflow: hidden; }
  #animation-box { width: 46px; height: 34px; background: #0ea5e9; animation: fidelity-slide 300ms linear infinite alternate; }
  @keyframes fidelity-slide { to { transform: translateX(190px); background: #22c55e; } }
  #cssom-fixture { background: #fef3c7; }
  #large-fixture { margin-top: 14px; width: 640px; min-height: 240px; padding: 4px; background: white; border: 1px solid #a1a1aa; }
  .large-cell { display: inline-flex; width: 24px; height: 14px; align-items: center; justify-content: center; font: 8px/1 Arial; color: #27272a; border-right: 1px solid #f4f4f5; border-bottom: 1px solid #f4f4f5; }
  #canvas-fixture, #iframe-fixture, #media-fixture, #font-fixture { margin-top: 14px; width: 640px; padding: 10px; background: white; border: 1px solid #a1a1aa; }
  #canvas-fixture { display: flex; gap: 12px; }
  #canvas-fixture canvas { width: 120px; height: 60px; border: 1px solid #d4d4d8; }
  #iframe-fixture { display: flex; gap: 10px; min-height: 112px; }
  #iframe-fixture iframe { width: 290px; height: 92px; border: 1px solid #71717a; }
  #media-fixture { min-height: 94px; }
  #late-image { display: block; width: 180px; height: 72px; }
  #font-fixture { min-height: 48px; font: 24px/1.2 Arial, sans-serif; }
  #large-svg-fixture { margin-top: 14px; width: 640px; height: 380px; background: white; border: 1px solid #a1a1aa; }
</style>
</head>
<body>
  <main id="fixture">
    <div class="row"><div class="block"></div><div id="accent"></div><div class="block"></div></div>
    <div class="line"></div>
    <div id="secret-block">SECRET TEXT</div>
    <input id="secret-input" value="secret-token" />
    <div class="feature-row">
      <div id="shadow-host"></div>
      <svg width="92" height="32" viewBox="0 0 92 32" aria-label="fixture-svg"><rect x="1" y="1" width="90" height="30" rx="5" fill="#6366f1"/><circle cx="20" cy="16" r="8" fill="#fff"/></svg>
      <div id="bleed"></div>
      <input id="stateful-input" type="checkbox" value="server-state" />
    </div>
  </main>
  <section id="animation-fixture"><div id="animation-box"></div></section>
  <section id="hydration-fixture">server</section>
  <section id="paint-hydration-fixture">server</section>
  <section id="cssom-fixture">cssom-only-style</section>
  <section id="hostile-fixture">isolated-world-boundary</section>
  <section id="dpr-fixture">device-pixel-ratio</section>
  <section id="canvas-fixture"><canvas id="canvas-2d" width="120" height="60"></canvas><canvas id="canvas-webgl" width="120" height="60"></canvas></section>
  <section id="iframe-fixture"><iframe id="same-frame" src="/iframe?kind=same"></iframe><iframe id="cross-frame" src="${crossFrame}"></iframe></section>
  <section id="media-fixture"><img id="late-image" width="180" height="72" alt="late fixture" /></section>
  <section id="font-fixture">Late font readiness 0123456789</section>
  <section id="large-fixture"></section>
  <svg id="large-svg-fixture" width="640" height="380" viewBox="0 0 640 380"></svg>
</body>
</html>`
}

function iframeHtml(kind: string) {
  return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;font:14px Arial;background:${kind === "cross" ? "#fee2e2" : "#dbeafe"};display:grid;place-items:center}</style><body>${kind}-origin-frame</body>`
}
