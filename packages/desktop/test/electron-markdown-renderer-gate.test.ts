import { execFile } from "node:child_process"
import { mkdtemp, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"
import appPlugins from "../../app/vite.js"
import { createServer } from "vite"
import { expect, test } from "bun:test"
import { privateViteIsolation } from "./private-vite-isolation"

const execFileAsync = promisify(execFile)

test("production Markdown component makes visible-tail progress under 1/3/6 stream load", async () => {
  const directory = await mkdtemp(join(import.meta.dir, ".electron-markdown-gate-"))
  const vite = await createServer({
    configFile: false,
    root: resolve(import.meta.dir, "markdown-renderer-gate"),
    plugins: appPlugins,
    ...await privateViteIsolation(join(directory, "vite-cache")),
    optimizeDeps: { exclude: ["shiki"], noDiscovery: true, entries: [] },
    appType: "spa",
  })
  try {
    await vite.listen()
    const address = vite.httpServer?.address()
    if (!address || typeof address === "string") throw new Error("Vite did not bind a TCP port")
    const markdownSourcePath = resolve(import.meta.dir, "../../session-ui/src/components/markdown.tsx").replaceAll("\\", "/")
    const markdownModule = await fetch(`http://127.0.0.1:${address.port}/@fs/${markdownSourcePath}`)
    expect(markdownModule.ok).toBe(true)
    expect(await markdownModule.text()).toContain("data-markdown-oversized-code")
    const build = await Bun.build({
      entrypoints: [resolve(import.meta.dir, "electron-markdown-renderer-gate.ts")],
      target: "node",
      format: "cjs",
      packages: "external",
      outdir: directory,
    })
    expect(build.success, build.logs.map((log) => log.message).join("\n")).toBe(true)
    const fixture = join(directory, "electron-markdown-renderer-gate.js")
    const main = join(directory, "electron-markdown-renderer-gate.cjs")
    await rename(fixture, main)
    await execFileAsync("node", ["--check", main], { cwd: directory })

    const electron = resolve(import.meta.dir, "../node_modules/electron/dist/electron.exe")
    const oversizedOnly = process.env.OPENFORK_MARKDOWN_GATE_OVERSIZED_ONLY === "1"
    const electronEnv = {
      ...process.env,
      OPENFORK_MARKDOWN_GATE_URL: `http://127.0.0.1:${address.port}/${oversizedOnly ? "?oversized-only=1" : ""}`,
      OPENFORK_FIXTURE_PROFILE_ROOT: join(directory, "electron-profile"),
    }
    delete electronEnv.ELECTRON_RUN_AS_NODE
    const result = await execFileAsync(electron, ["--no-sandbox", "--disable-gpu", main], {
      cwd: resolve(import.meta.dir, "../../.."),
      env: electronEnv,
      timeout: 300_000,
      maxBuffer: 2 * 1024 * 1024,
    })
    const marker = result.stdout.split("\n").find((line) => line.startsWith("ELECTRON_MARKDOWN_GATE_RESULT "))
    expect(marker, result.stdout + result.stderr).toBeTruthy()
    const evidence = JSON.parse(marker!.slice("ELECTRON_MARKDOWN_GATE_RESULT ".length)) as {
      visibilityState: string
      profile?: { userData: string; sessionData: string; logs: string; crashDumps: string }
      scenarios: Array<{
        scenario?: string
        concurrency?: number
        backgroundHistoryBytes?: number
        backgroundStillRunningWhenTailFinished?: boolean
        offscreenWorkerJobs?: number
        offscreenMarkerRendered?: boolean
        tailDomCommitMsBySession?: Array<number | null>
        tailWorkerDoneMs?: number
        framesUntilDomCommit?: number
        animationFramesDuringProgress?: number
        renderedMarkerCount?: number
        tailWorkerEvents?: number
        maxTailQueueWaitMs?: number
        teardownMarkdownRoots?: number
        sessionStoreSeeded?: boolean
        activeInterestAtConcurrency?: boolean
        interestDuringGapPreserved?: boolean
        interestReleased?: boolean
        gapLatched?: boolean
        gapRepaired?: boolean
        repairedText?: boolean
        staleSuperseded?: boolean
        reenteredTailPriority?: boolean
        initialWorkerDone?: number
        expectedInitialWorkerDone?: number
        initialTailDone?: number
        historyBlocks?: number
        richInlineCodeNodes?: number
        denseCodeCooperativeMounts?: number
        denseCodeTrace?: Array<{ action?: string; chars?: number; tokenCount?: number } | undefined>
        denseCodeBySession?: Array<{ present: boolean; pending: boolean; textLength: number; tokenSpanCount: number; lastEntryPresent: boolean }>
        maximumFrameGapMs?: number
        historyNodeIdentityPreserved?: boolean
        effectBlockCount?: number
        blockWritesOnTail?: number
        fullBlockWritesOnTail?: number
        parseEventsOnTail?: number
        highlightEventsOnTail?: number
        tailHighlightLanes?: number[]
        codeUpdateTokenSum?: number
        shikiBySession?: Array<{
          hasShiki: boolean
          tokenSpanCount: number
          styledSpanCount: number
          matches: boolean
        }>
        inputBytes?: number
        overPerJobLimit?: boolean
        markerVisible?: boolean
        rawSyntaxSeen?: boolean
        firstPaintMs?: number
        totalRenderMs?: number
        parsesAtFirstPaint?: number
        expectedParses?: number
        mutations?: number
        headingPreserved?: boolean
        bodyExact?: boolean
        strongCount?: number
        continuationIdentityPreserved?: boolean
        pendingCount?: number
        reenteredRichBody?: boolean
        largeWorkAfterTeardown?: { queuedJobs: number; activeJobs: number; pendingRequests: number }
        coldHiddenWorkerJobs?: number
        coldHiddenWorkerEvents?: Array<{ kind?: string; status?: string; priority?: string; chars?: number }>
        coldHiddenHasContentBlock?: boolean
        coldHiddenPlaceholderHeight?: number
        maximumFrameGapMs?: number
        expectedTextLength?: number
        outputTextLength?: number
        diagnostics?: { ready: boolean; blockCount: number; pendingCount: number; workerEvents: unknown[]; effects: unknown[] }
        codeShell?: boolean
        copyControl?: boolean
        copyWasPending?: boolean
        clipboardTextLength?: number
        clipboardExact?: boolean
        domCommit?: { maxBatchChars: number; maxBatchNodes: number; maxBatchSteps: number; maxRichParsesPerFrame: number; completedJobs: number }
        frameWork?: { queuedJobs: number; reservedJobs: number; waitingDemand: number }
      }>
    }
    console.log("Electron Markdown evidence:", evidence)
    const evidencePath = process.env.OPENFORK_MARKDOWN_GATE_EVIDENCE_PATH
    if (evidencePath) await Bun.write(evidencePath, JSON.stringify(evidence, null, 2) + "\n")
    expect(evidence.profile?.userData).toBe(join(directory, "electron-profile", "user-data"))
    expect(evidence.profile?.sessionData).toBe(join(directory, "electron-profile", "session-data"))
    expect(evidence.profile?.logs).toBe(join(directory, "electron-profile", "logs"))
    expect(evidence.profile?.crashDumps).toBe(join(directory, "electron-profile", "crash-dumps"))
    const batchFirstPaint = evidence.scenarios.find((scenario) => scenario.scenario === "batched-rich-first-paint")
    expect(batchFirstPaint?.rawSyntaxSeen).toBe(false)
    expect(batchFirstPaint?.bodyExact).toBe(true)
    expect(batchFirstPaint?.headingPreserved).toBe(true)
    expect(batchFirstPaint?.parsesAtFirstPaint).toBeLessThan(batchFirstPaint?.expectedParses ?? 0)
    const streamScenarios = evidence.scenarios.filter((scenario) => scenario.concurrency !== undefined)
    const oversizedCode = evidence.scenarios.find((scenario) => scenario.scenario === "oversized-fenced-code-fallback")
    console.log(
      "Dense Markdown mount trace:",
      JSON.stringify(
        streamScenarios.map((scenario) => ({
          concurrency: scenario.concurrency,
          trace: scenario.denseCodeTrace,
          rendered: scenario.denseCodeBySession,
          cooperativeMounts: scenario.denseCodeCooperativeMounts,
        })),
      ),
    )
    console.log(
      "Oversized code fallback proof:",
      JSON.stringify({
        expectedTextLength: oversizedCode?.expectedTextLength,
        outputTextLength: oversizedCode?.outputTextLength,
        markerVisible: oversizedCode?.markerVisible,
        diagnostics: oversizedCode?.diagnostics,
        domCommit: oversizedCode?.domCommit,
        frameWork: oversizedCode?.frameWork,
        coldHiddenWorkerJobs: oversizedCode?.coldHiddenWorkerJobs,
        coldHiddenHasContentBlock: oversizedCode?.coldHiddenHasContentBlock,
      }),
    )
    if (!oversizedOnly) {
    expect(streamScenarios.map((scenario) => scenario.concurrency)).toEqual([1, 3, 6])
    expect(streamScenarios.every((scenario) => (scenario.tailWorkerEvents ?? 0) >= (scenario.concurrency ?? 0) * 2)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.renderedMarkerCount === scenario.concurrency)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.sessionStoreSeeded === true)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.activeInterestAtConcurrency === true)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.interestDuringGapPreserved === true)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.interestReleased === true)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.gapLatched && scenario.gapRepaired && scenario.repairedText)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.staleSuperseded === true)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.offscreenWorkerJobs === 0 && scenario.reenteredTailPriority)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.tailDomCommitMsBySession?.length === scenario.concurrency)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.tailDomCommitMsBySession?.every((value) => value !== null))).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.teardownMarkdownRoots === 0)).toBe(true)
    expect(streamScenarios.every((scenario) => (scenario.initialWorkerDone ?? 0) >= (scenario.expectedInitialWorkerDone ?? Infinity))).toBe(true)
    expect(streamScenarios.every((scenario) => (scenario.historyBlocks ?? 0) >= 27 && (scenario.effectBlockCount ?? 0) >= 27)).toBe(true)
    expect(streamScenarios.every((scenario) => (scenario.richInlineCodeNodes ?? 0) >= 800)).toBe(true)
    expect(streamScenarios.every((scenario) => (scenario.denseCodeCooperativeMounts ?? 0) >= (scenario.concurrency ?? Infinity))).toBe(true)
    expect(streamScenarios.every((scenario) =>
      scenario.denseCodeBySession?.length === scenario.concurrency &&
      scenario.denseCodeBySession.every((block) => block.present && !block.pending && block.lastEntryPresent && block.textLength > 8000 && block.tokenSpanCount > 128)
    )).toBe(true)
    expect(streamScenarios.every((scenario) => (scenario.maximumFrameGapMs ?? Infinity) < 250)).toBe(true)
    expect(streamScenarios.every((scenario) =>
      scenario.frameWork?.queuedJobs === 0 &&
      scenario.frameWork.reservedJobs === 0 &&
      scenario.frameWork.waitingDemand === 0
    )).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.historyNodeIdentityPreserved === true)).toBe(true)
    expect(streamScenarios.every((scenario) => scenario.highlightEventsOnTail === scenario.concurrency)).toBe(true)
    expect(streamScenarios.every((scenario) =>
      scenario.tailHighlightLanes?.length === scenario.concurrency &&
      scenario.tailHighlightLanes.every((lane) => lane === 1)
    )).toBe(true)
    expect(
      streamScenarios.every(
        (scenario) =>
          scenario.shikiBySession?.length === scenario.concurrency &&
          scenario.shikiBySession.every(
            (item) => item.matches && item.hasShiki && item.tokenSpanCount > 0,
          ),
      ),
    ).toBe(true)
    expect(streamScenarios.every((scenario) => (scenario.initialTailDone ?? 0) >= (scenario.concurrency ?? Infinity))).toBe(true)
    expect(streamScenarios[0]?.backgroundHistoryBytes).toBe(8 * 1024 * 1024)
    expect(streamScenarios[0]?.backgroundStillRunningWhenTailFinished).toBe(true)
    }
    const firstPaint = evidence.scenarios.find((scenario) => scenario.scenario === "rich-first-paint")
    expect(firstPaint?.markerVisible).toBe(true)
    expect(firstPaint?.rawSyntaxSeen).toBe(false)
    expect(firstPaint?.mutations).toBeGreaterThan(0)
    expect(firstPaint?.headingPreserved).toBe(true)
    const richLarge = evidence.scenarios.find((scenario) => scenario.scenario === "oversized-rich-markdown")
    expect(richLarge?.markerVisible).toBe(true)
    expect(richLarge?.bodyExact).toBe(true)
    expect(richLarge?.strongCount).toBe(1)
    expect(richLarge?.continuationIdentityPreserved).toBe(true)
    expect(richLarge?.pendingCount).toBe(0)
    expect(richLarge?.reenteredRichBody).toBe(true)
    expect(richLarge?.largeWorkAfterTeardown).toEqual({ queuedJobs: 0, activeJobs: 0, pendingRequests: 0 })
    expect(richLarge?.maximumFrameGapMs).toBeLessThan(250)
    const fallback = evidence.scenarios.find((scenario) => scenario.scenario === "oversized-plaintext-fallback")
    console.log(
      "Oversized plain-text hidden worker proof:",
      JSON.stringify({
        coldHiddenWorkerJobs: fallback?.coldHiddenWorkerJobs,
        coldHiddenWorkerEvents: fallback?.coldHiddenWorkerEvents,
        diagnostics: fallback?.diagnostics,
      }),
    )
    expect(fallback?.overPerJobLimit).toBe(true)
    expect(fallback?.markerVisible).toBe(true)
    expect(fallback?.teardownMarkdownRoots).toBe(0)
    expect(fallback?.coldHiddenWorkerJobs).toBe(0)
    expect(fallback?.coldHiddenHasContentBlock).toBe(false)
    expect(fallback?.coldHiddenPlaceholderHeight).toBeGreaterThan(0)
    expect(fallback?.diagnostics?.workerEvents).toHaveLength(0)
    expect(fallback?.domCommit?.maxBatchChars).toBeLessThanOrEqual(64 * 1024)
    expect(fallback?.domCommit?.maxBatchNodes).toBeLessThanOrEqual(128)
    expect(fallback?.maximumFrameGapMs).toBeLessThan(250)
    expect(fallback?.frameWork?.queuedJobs).toBe(0)
    expect(fallback?.frameWork?.reservedJobs).toBe(0)
    console.log(
      "Oversized code fallback proof:",
      JSON.stringify({
        expectedTextLength: oversizedCode?.expectedTextLength,
        outputTextLength: oversizedCode?.outputTextLength,
        markerVisible: oversizedCode?.markerVisible,
        diagnostics: oversizedCode?.diagnostics,
        domCommit: oversizedCode?.domCommit,
        frameWork: oversizedCode?.frameWork,
        coldHiddenWorkerJobs: oversizedCode?.coldHiddenWorkerJobs,
        coldHiddenHasContentBlock: oversizedCode?.coldHiddenHasContentBlock,
      }),
    )
    expect(oversizedCode?.overPerJobLimit).toBe(true)
    expect(oversizedCode?.markerVisible).toBe(true)
    expect(oversizedCode?.outputTextLength).toBe(oversizedCode?.expectedTextLength)
    expect(oversizedCode?.codeShell).toBe(true)
    expect(oversizedCode?.oversizedCodeScrollable).toBe(true)
    expect(oversizedCode?.diagnostics?.virtualizedSourceControl).toBe(true)
    expect(oversizedCode?.copyControl).toBe(true)
    expect(oversizedCode?.copyWasPending).toBe(true)
    expect(oversizedCode?.clipboardTextLength).toBe(oversizedCode?.expectedTextLength)
    expect(oversizedCode?.clipboardExact).toBe(true)
    expect(oversizedCode?.coldHiddenWorkerJobs).toBe(0)
    expect(oversizedCode?.coldHiddenHasContentBlock).toBe(false)
    expect(oversizedCode?.diagnostics?.workerEvents).toHaveLength(0)
    expect(oversizedCode?.teardownMarkdownRoots).toBe(0)
    expect(oversizedCode?.maximumFrameGapMs).toBeLessThan(250)
    expect(oversizedCode?.domCommit?.maxBatchChars).toBeLessThanOrEqual(64 * 1024)
    expect(oversizedCode?.domCommit?.maxBatchNodes).toBeLessThanOrEqual(128)
    expect(oversizedCode?.domCommit?.maxBatchSteps).toBeLessThanOrEqual(128)
    expect(oversizedCode?.domCommit?.maxRichParsesPerFrame).toBeLessThanOrEqual(1)
    expect(oversizedCode?.frameWork?.queuedJobs).toBe(0)
    expect(oversizedCode?.frameWork?.reservedJobs).toBe(0)
  } finally {
    await vite.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 360_000)
