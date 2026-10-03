import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createServerSession } from "../../../app/src/context/server-session"
import { Markdown } from "../../../session-ui/src/components/markdown"
import { markdownDomCommitSnapshot } from "../../../session-ui/src/components/markdown-dom-commit"
import { markdownFrameWorkSnapshot } from "../../../session-ui/src/components/markdown-frame-work"
import type { MarkdownTraceEvent } from "../../../session-ui/src/components/markdown-trace"
import { highlightStreamingCode, parseMarkdown } from "../../../session-ui/src/components/markdown-worker"

declare global {
  interface Window {
    __markdownGate?: { run: () => Promise<unknown> }
    __markdownTraceEvents?: MarkdownTraceEvent[]
  }
}

window.__markdownTraceEvents = []
window.__opencodeMarkdownTraceEnabled = () => true
window.__opencodeMarkdownTrace = (event: MarkdownTraceEvent) => window.__markdownTraceEvents!.push(event)

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const textContent = (element: Element) => element.textContent ?? ""
let animationTicks = 0
let lastAnimationFrameAt = performance.now()
let maxFrameGapMs = 0
const animate = (time: number) => {
  maxFrameGapMs = Math.max(maxFrameGapMs, time - lastAnimationFrameAt)
  lastAnimationFrameAt = time
  animationTicks++
  requestAnimationFrame(animate)
}
requestAnimationFrame(animate)
const GATE_CODE = '```json\n{\n  "id": "gate",\n  "count": 41,\n  "ok": true,\n  "note": "alpha beta"\n}\n```'
const DENSE_JSON = `\`\`\`json
{
  "dense": [
${Array.from({ length: 500 }, (_, index) => `    "entry-${index}",`).join("\n")}
  ]
}
\`\`\``
const INLINE_CODE_DENSE_BLOCK = Array.from({ length: 800 }, (_, index) => `inline `token-${index}``).join(" ")
const makeHistory = (session: number) => {
  const blocks: string[] = [`### Session ${session} completed history`]
  for (let index = 1; index <= 24; index++) {
    blocks.push(
      index === 13
        ? GATE_CODE
        : `Paragraph ${index} with **stable content**, identifiers, and ordinary words. `.repeat(34),
    )
  }
  blocks.push(INLINE_CODE_DENSE_BLOCK)
  blocks.push(DENSE_JSON)
  return blocks.join("\n\n")
}

function sessionFixture(sessionIDs: string[]) {
  const currentText = new Map(sessionIDs.map((id, index) => [id, makeHistory(index)]))
  const messageIDs = new Map(sessionIDs.map((id) => [id, `assistant-${id}`]))
  const partIDs = new Map(sessionIDs.map((id) => [id, `part-${id}`]))
  const interestHistory: string[][] = []
  let holdNextMessages = false
  let repairStartedResolve: (() => void) | undefined
  const repairStarted = new Promise<void>((resolve) => { repairStartedResolve = resolve })
  let repairResponseResolve: (() => void) | undefined
  const repairResponse = new Promise<void>((resolve) => { repairResponseResolve = resolve })
  const sessionInfo = (id: string) => ({
    id,
    slug: id,
    projectID: "markdown-gate",
    directory: "/markdown-gate",
    title: id,
    version: "1",
    time: { created: 1, updated: 1 },
  })
  const responsePage = (id: string) => {
    const userID = `user-${id}`
    const assistantID = messageIDs.get(id)!
    const partID = partIDs.get(id)!
    const text = currentText.get(id)!
    return {
      data: [
        {
          info: {
            id: userID,
            sessionID: id,
            role: "user",
            time: { created: 1 },
            agent: "build",
            model: { providerID: "gate", modelID: "gate" },
          },
          parts: [],
        },
        {
          info: {
            id: assistantID,
            sessionID: id,
            role: "assistant",
            parentID: userID,
            time: { created: 2 },
            modelID: "gate",
            providerID: "gate",
            mode: "build",
            agent: "build",
            path: { cwd: "/markdown-gate", root: "/markdown-gate" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          },
          parts: [{ id: partID, sessionID: id, messageID: assistantID, type: "text", text }],
        },
      ],
      response: { headers: new Headers() },
    }
  }
  const client = {
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ data: sessionInfo(sessionID) }),
      messages: async ({ sessionID }: { sessionID: string }) => {
        if (holdNextMessages) {
          holdNextMessages = false
          repairStartedResolve?.()
          await repairResponse
        }
        return responsePage(sessionID)
      },
    },
  }
  const store = createServerSession(client as never, {
    protocol: Promise.resolve("v1"),
    onStreamInterestChanged: (sessions) => interestHistory.push([...sessions]),
  })
  return {
    store,
    currentText,
    messageIDs,
    partIDs,
    interestHistory,
    async seedOffscreen(id: string) {
      await store.sync(id, { activate: false })
    },
    activate(id: string) {
      store.resume(id)
    },
    setBusy(id: string) {
      store.apply({ type: "session.status", properties: { sessionID: id, status: { type: "busy" } } })
    },
    delta(id: string, text: string, offset: number) {
      if (!store.acceptStreamContent(id)) throw new Error(`Session ${id} did not have active stream interest`)
      currentText.set(id, `${currentText.get(id)!}${text}`)
      store.apply({
        type: "message.part.delta",
        properties: { sessionID: id, messageID: messageIDs.get(id), partID: partIDs.get(id), field: "text", delta: text, offset },
      })
    },
    replacePart(id: string, text: string) {
      if (!store.acceptStreamContent(id)) throw new Error(`Session ${id} did not have active stream interest`)
      currentText.set(id, text)
      store.apply({
        type: "message.part.updated",
        properties: {
          sessionID: id,
          part: { id: partIDs.get(id), sessionID: id, messageID: messageIDs.get(id), type: "text", text },
        },
      })
    },
    holdRepair() {
      holdNextMessages = true
      return { started: repairStarted, release: () => repairResponseResolve?.() }
    },
    releaseAll() {
      for (const id of sessionIDs) store.release(id)
    },
  }
}

window.__markdownGate = {
  async run() {
    const results: Array<Record<string, unknown>> = []
    const root = document.querySelector<HTMLElement>("#root")!
    await Promise.all([
      parseMarkdown("# background worker warmup", "markdown-gate-warmup-background", "background"),
      parseMarkdown("# tail worker warmup", "markdown-gate-warmup-tail", "tail"),
      parseMarkdown(GATE_CODE, "markdown-gate-warmup-code-background", "background"),
      highlightStreamingCode(
        "markdown-gate-warmup-code-tail",
        '{"ok":true,"count":41,"label":"alpha"}',
        "json",
        true,
        "tail",
      ),
    ])
    for (const concurrency of [1, 3, 6]) {
      maxFrameGapMs = 0
      root.replaceChildren()
      window.__markdownTraceEvents = []
      const sessionIDs = Array.from({ length: concurrency }, (_, index) => `markdown-gate-${concurrency}-${index}`)
      const fixture = sessionFixture(sessionIDs)
      await Promise.all(sessionIDs.map((id) => fixture.seedOffscreen(id)))
      sessionIDs.forEach((id) => fixture.activate(id))
      const entries: Array<{ element: HTMLElement; text: string; id: string }> = []
      const disposers: Array<() => void> = []
      for (let session = 0; session < concurrency; session++) {
        const element = document.createElement("section")
        // Keep every streamed root inside the viewport to exercise multiple
        // simultaneously visible tails sharing the reserved worker lane.
        element.style.cssText = `height:${Math.floor(700 / concurrency)}px;padding:8px;overflow:hidden`
        root.append(element)
        const text = makeHistory(session)
        const id = sessionIDs[session]!
        fixture.setBusy(id)
        disposers.push(
          render(
            () => (
              <Markdown
                text={fixture.store.data.part[fixture.messageIDs.get(id)!]?.[0]?.text ?? ""}
                cacheKey={id}
                streaming={fixture.store.data.session_working(id)}
              />
            ),
            element,
          ),
        )
        entries.push({ element, text, id })
      }
      await frame()
      await frame()
      let initialFrames = 0
      const expectedInitialWorkerDone = concurrency * 28
      while (initialFrames < 1800) {
        const initialWorkerDone = (window.__markdownTraceEvents ?? []).filter(
          (event) => event.phase === "worker" && event.status === "ok",
        ).length
        const initialTailDone = (window.__markdownTraceEvents ?? []).filter(
          (event) => event.phase === "worker" && event.priority === "tail" && event.status === "ok",
        ).length
        const initialDOMComplete = entries.every(
          (entry) =>
            entry.element.querySelectorAll("[data-markdown-block]").length >= 27 &&
            entry.element.querySelectorAll("[data-markdown-pending]").length === 0,
        )
        const sanitizer = markdownFrameWorkSnapshot()
        const commits = markdownDomCommitSnapshot()
        if (
          initialWorkerDone >= expectedInitialWorkerDone &&
          initialTailDone >= concurrency * 2 &&
          initialDOMComplete &&
          sanitizer.queuedJobs === 0 &&
          sanitizer.reservedJobs === 0 &&
          sanitizer.waitingDemand === 0 &&
          commits.queuedJobs === 0
        ) break
        await frame()
        initialFrames++
      }
      const initialWorkerDone = (window.__markdownTraceEvents ?? []).filter(
        (event) => event.phase === "worker" && event.status === "ok",
      ).length
      const initialTailDone = (window.__markdownTraceEvents ?? []).filter(
        (event) => event.phase === "worker" && event.priority === "tail" && event.status === "ok",
      ).length
      // Worker completion is not the DOM commit barrier. Let the final initial
      // render effects drain before opening the measurement window for the
      // appended live suffix; otherwise completed-history writes pollute the
      // tail-only block counters on fast single-session runs.
      await frame()
      await frame()
      const initialBlockNodes = entries.map((entry) =>
        Array.from(entry.element.querySelectorAll("[data-markdown-block]")),
      )
      const denseCodeCooperativeMounts = (window.__markdownTraceEvents ?? []).filter(
        (event) => event.phase === "block" && event.action === "cooperative-code-mount" && event.mode === "code",
      ).length
      window.__markdownTraceEvents = []
      // Start a parse just below the admitted byte ceiling on the background-
      // only worker lane before emitting a visible tail. A second worker lane
      // is reserved for the live tail, so FIFO admission cannot place the tail
      // behind this non-preemptible parse.
      const phrase = "[completed history](https://example.com) "
      const targetChars = 4_194_304
      const largeHistory = phrase.repeat(Math.floor(targetChars / phrase.length)) + phrase.slice(0, targetChars % phrase.length)
      const backgroundJobs = [parseMarkdown(largeHistory, `completed-history-background-${concurrency}`, "background")]
      let backgroundSettled = false
      void Promise.all(backgroundJobs).then(() => { backgroundSettled = true })
      // Let the worker begin the parse before issuing the tail. The source is
      // intentionally token-dense so the worker remains occupied after the
      // renderer has finished cloning the bounded request.
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      const start = performance.now()
      const startAnimationTicks = animationTicks
      for (let session = 0; session < concurrency; session++) {
        const entry = entries[session]!
        const tail =
          `\n\nvisible-tail-marker-${concurrency}-${session}\n\n` +
          "~~~json\n" +
          `{ "tail": ${concurrency}, "label": "alpha", "n": ${session} }\n`
        fixture.delta(entry.id, tail.replace("~~~", "```"), entry.text.length)
      }
      const domCommittedAt = Array.from<number | undefined>({ length: concurrency }, () => undefined)
      let domFrames = 0
      while (domFrames < 1800 && domCommittedAt.some((value) => value === undefined)) {
        await frame()
        domFrames++
        entries.forEach((entry, index) => {
          if (domCommittedAt[index] !== undefined) return
          if (textContent(entry.element).includes(`visible-tail-marker-${concurrency}-${index}`))
            domCommittedAt[index] = performance.now() - start
        })
      }
      let workerFrames = 0
      while (workerFrames < 1800) {
        await frame()
        workerFrames++
        const completedTails = (window.__markdownTraceEvents ?? []).filter(
          (event) => event.phase === "worker" && event.priority === "tail" && event.status === "ok",
        ).length
        if (completedTails >= concurrency * 2) break
      }
      const tailWorkerDoneMs = performance.now() - start
      const backgroundStillRunningWhenTailFinished = !backgroundSettled
      const animationFramesDuringProgress = animationTicks - startAnimationTicks
      await Promise.all(backgroundJobs)
      const allMarkers = entries.every((entry, session) =>
        textContent(entry.element).includes(`visible-tail-marker-${concurrency}-${session}`),
      )
      const events = window.__markdownTraceEvents ?? []
      const workerEvents = events.filter((event) => event.phase === "worker")
      const tailEvents = workerEvents.filter((event) => event.priority === "tail" && event.status === "ok")
      const backgroundEvents = workerEvents.filter((event) => event.priority === "background" && event.status === "ok")
      const blockEvents = events.filter((event) => event.phase === "block")
      const blockWrites = blockEvents.filter((event) => event.phase === "block" && event.action !== "skip")
      const codeEvents = blockEvents.filter((event) => event.phase === "block" && event.mode === "code")
      const latestEffect = [...events].reverse().find((event) => event.phase === "effect")
      const shikiBySession = entries.map((entry) => {
        const shiki = entry.element.querySelector<HTMLElement>(".shiki code")
        const spans = Array.from(shiki?.querySelectorAll<HTMLElement>("span") ?? [])
        const styled = spans.filter(
          (span) => span.className.startsWith("oc-md-token-") || span.style.cssText.length > 0,
        )
        return {
          hasShiki: shiki !== null,
          tokenSpanCount: spans.length,
          styledSpanCount: styled.length,
          matches: textContent(entry.element).includes('"label": "alpha"'),
        }
      })
      const historyNodeIdentityPreserved = entries.every((entry, session) => {
        const current = Array.from(entry.element.querySelectorAll("[data-markdown-block]"))
        return initialBlockNodes[session]!.every((node, index) => current[index] === node)
      })
      const activeAfterCommit = entries[0]!.element.querySelectorAll("[data-component='markdown']").length
      const renderedMarkerCount = entries.filter((entry, session) =>
        textContent(entry.element).includes(`visible-tail-marker-${concurrency}-${session}`),
      ).length
      const priorityEntry = entries.at(-1)!
      priorityEntry.element.style.marginTop = "1200px"
      await frame()
      await frame()
      await frame()
      window.__markdownTraceEvents = []
      const hiddenText = fixture.currentText.get(priorityEntry.id)!
      fixture.delta(priorityEntry.id, "\n\nbackground-priority-marker", hiddenText.length)
      for (let attempt = 0; attempt < 120; attempt++) {
        const completed = (window.__markdownTraceEvents ?? []).filter(
          (event) => event.phase === "worker" && event.priority === "background" && event.status === "ok",
        )
        if (textContent(priorityEntry.element).includes("background-priority-marker") && completed.length >= 2) break
        await frame()
      }
      const backgroundPriorityObserved = (window.__markdownTraceEvents ?? []).some(
        (event) => event.phase === "worker" && event.priority === "background" && event.status === "ok",
      )
      priorityEntry.element.style.marginTop = "0"
      await frame()
      await frame()
      await frame()
      window.__markdownTraceEvents = []
      const visibleText = fixture.currentText.get(priorityEntry.id)!
      fixture.delta(priorityEntry.id, "\n\ntail-priority-marker", visibleText.length)
      for (let attempt = 0; attempt < 120; attempt++) {
        const completed = (window.__markdownTraceEvents ?? []).filter(
          (event) => event.phase === "worker" && event.priority === "tail" && event.status === "ok",
        )
        if (textContent(priorityEntry.element).includes("tail-priority-marker") && completed.length >= 2) break
        await frame()
      }
      const reenteredTailPriority = (window.__markdownTraceEvents ?? []).some(
        (event) => event.phase === "worker" && event.priority === "tail" && event.status === "ok",
      )
      const staleUpdateID = entries[0]!.id
      const staleMarker = `obsolete-tail-marker-${concurrency}`
      fixture.replacePart(staleUpdateID, `${fixture.currentText.get(staleUpdateID)!}\n\n${staleMarker}`)
      await frame()
      fixture.replacePart(staleUpdateID, `${entries[0]!.text}\n\nlatest-tail-marker-${concurrency}`)
      for (let attempt = 0; attempt < 1800; attempt++) {
        if (textContent(entries[0]!.element).includes(`latest-tail-marker-${concurrency}`)) break
        await frame()
      }
      const staleSuperseded = !textContent(entries[0]!.element).includes(staleMarker)
      const repair = fixture.holdRepair()
      const beforeGap = fixture.currentText.get(staleUpdateID)!
      fixture.currentText.set(staleUpdateID, `${beforeGap}\n\nrepaired-from-server`)
      fixture.store.apply({
        type: "message.part.delta",
        properties: {
          sessionID: staleUpdateID,
          messageID: fixture.messageIDs.get(staleUpdateID),
          partID: fixture.partIDs.get(staleUpdateID),
          field: "text",
          delta: "gap",
          offset: beforeGap.length + 3,
        },
      })
      await repair.started
      const gapLatched = fixture.store.needsRepair(staleUpdateID)
      const activeInterestDuringGap = fixture.interestHistory.at(-1)?.length === concurrency
      repair.release()
      for (let attempt = 0; attempt < 120 && fixture.store.needsRepair(staleUpdateID); attempt++) await new Promise((resolve) => setTimeout(resolve, 10))
      await frame()
      await frame()
      const gapRepaired = !fixture.store.needsRepair(staleUpdateID)
      const repairedText = textContent(entries[0]!.element).includes("repaired-from-server")
      fixture.releaseAll()
      const interestReleased = fixture.interestHistory.at(-1)?.length === 0
      results.push({
        concurrency,
        sessionStoreSeeded: sessionIDs.every((id) => fixture.store.data.message[id]?.length === 2),
        activeInterestAtConcurrency: fixture.interestHistory.some((ids) => ids.length === concurrency),
        interestDuringGapPreserved: activeInterestDuringGap,
        interestReleased,
        gapLatched,
        gapRepaired,
        repairedText,
        staleSuperseded,
        backgroundPriorityObserved,
        reenteredTailPriority,
        initialWorkerDone,
        expectedInitialWorkerDone,
        initialTailDone,
        historyChars: entries.reduce((total, entry) => total + entry.text.length, 0),
        backgroundHistoryChars: largeHistory.length * backgroundJobs.length,
        backgroundHistoryBytes: largeHistory.length * 2,
        backgroundStillRunningWhenTailFinished,
        backgroundParseMs: backgroundEvents.map((event) => event.phase === "worker" ? event.workerMs ?? null : null),
        tailDomCommitMsBySession: domCommittedAt.map((value) => (value === undefined ? null : Number(value.toFixed(2)))),
        tailWorkerDoneMs: Number(tailWorkerDoneMs.toFixed(2)),
        framesUntilDomCommit: domFrames,
        framesUntilTailWorker: workerFrames,
        animationFramesDuringProgress,
        renderedMarkerCount,
        allMarkers,
        workerEvents: workerEvents.length,
        workerKinds: [...new Set(workerEvents.map((event) => event.phase === "worker" ? event.kind : "unknown"))],
        workerPriorities: [...new Set(workerEvents.map((event) => event.phase === "worker" ? event.priority ?? "unset" : "unset"))],
        tailWorkerEvents: tailEvents.length,
        tailWorkerKinds: tailEvents.map((event) => event.phase === "worker" ? event.kind : "unknown"),
        tailWorkerStatuses: tailEvents.map((event) => event.phase === "worker" ? event.status : "unknown"),
        tailWorkerServiceMs: tailEvents.map((event) => event.phase === "worker" ? event.workerMs ?? null : null),
        tailQueueWaitMs: tailEvents.map((event) => event.phase === "worker" ? event.dispatchWaitMs ?? null : null),
        maxTailQueueWaitMs: Number(Math.max(0, ...tailEvents.map((event) => event.phase === "worker" ? event.dispatchWaitMs ?? 0 : 0)).toFixed(2)),
        historyBlocks: entries[0]!.element.querySelectorAll("[data-markdown-block]").length,
        richInlineCodeNodes: entries[0]!.element.querySelectorAll("code").length,
        denseCodeCooperativeMounts,
        maximumFrameGapMs: Number(maxFrameGapMs.toFixed(2)),
        historyNodeIdentityPreserved,
        effectBlockCount: latestEffect?.phase === "effect" ? latestEffect.blockCount : 0,
        blockWritesOnTail: blockWrites.length,
        fullBlockWritesOnTail: blockWrites.filter(
          (event) => event.phase === "block" && event.mode === "full",
        ).length,
        blockSkipsOnTail: blockEvents.length - blockWrites.length,
        parseEventsOnTail: workerEvents.filter((event) => event.phase === "worker" && event.kind === "parse").length,
        highlightEventsOnTail: workerEvents.filter((event) => event.phase === "worker" && event.kind === "highlight").length,
        tailHighlightLanes: workerEvents
          .filter((event) => event.phase === "worker" && event.kind === "highlight")
          .map((event) => event.phase === "worker" ? event.lane ?? -1 : -1),
        codeUpdateTokenSum: codeEvents.reduce(
          (sum, event) => sum + (event.phase === "block" ? event.tokenCount ?? 0 : 0),
          0,
        ),
        shikiBySession,
        visibleMarkdownRoots: activeAfterCommit,
        frameWork: markdownFrameWorkSnapshot(),
      })
      disposers.forEach((dispose) => dispose())
      await frame()
      await frame()
      results[results.length - 1]!.teardownMarkdownRoots = root.querySelectorAll("[data-component='markdown']").length
    }
    root.replaceChildren()
    const fallbackElement = document.createElement("section")
    fallbackElement.style.opacity = "0"
    root.append(fallbackElement)
    const oversizedText = `${"plain text ".repeat(419_431)}oversized-plaintext-marker`
    const [oversized, setOversized] = createSignal(oversizedText)
    window.__markdownTraceEvents = []
    const disposeFallback = render(() => <Markdown text={oversized()} cacheKey="oversized-plaintext-fallback" />, fallbackElement)
    await frame()
    await frame()
    const coldHiddenWorkerJobs = (window.__markdownTraceEvents ?? []).filter((event) => event.phase === "worker").length
    const coldHiddenHasContentBlock = !!fallbackElement.querySelector("[data-markdown-block]")
    const coldHiddenPlaceholderHeight = fallbackElement.querySelector<HTMLElement>("[data-markdown-placeholder]")?.getBoundingClientRect().height ?? 0
    maxFrameGapMs = 0
    fallbackElement.style.opacity = "1"
    let fallbackFrames = 0
    while (
      fallbackFrames < 1800 &&
      (textContent(fallbackElement).length !== oversizedText.length || markdownDomCommitSnapshot().queuedJobs > 0)
    ) {
      await frame()
      fallbackFrames++
    }
    const fallbackVisible =
      textContent(fallbackElement).length === oversizedText.length &&
      textContent(fallbackElement).includes("oversized-plaintext-marker") &&
      markdownDomCommitSnapshot().queuedJobs === 0
    const fallbackTextLength = textContent(fallbackElement).length
    disposeFallback()
    await frame()
    results.push({
      scenario: "oversized-plaintext-fallback",
      inputBytes: oversizedText.length * 2,
      overPerJobLimit: oversizedText.length * 2 > 8 * 1024 * 1024,
      markerVisible: fallbackVisible,
      outputTextLength: fallbackTextLength,
      coldHiddenWorkerJobs,
      coldHiddenHasContentBlock,
      coldHiddenPlaceholderHeight,
      maximumFrameGapMs: Number(maxFrameGapMs.toFixed(2)),
      domCommit: markdownDomCommitSnapshot(),
      frameWork: markdownFrameWorkSnapshot(),
      teardownMarkdownRoots: root.querySelectorAll("[data-component='markdown']").length,
    })
    root.replaceChildren()
    const oversizedCodeElement = document.createElement("section")
    oversizedCodeElement.style.opacity = "0"
    root.append(oversizedCodeElement)
    const oversizedCodeBody = `oversized-code-marker\n${"const fixtureValue = 1;\n".repeat(190_000)}`
    const oversizedCodeSource = `\`\`\`text\n${oversizedCodeBody}\`\`\``
    const [oversizedCode] = createSignal(oversizedCodeSource)
    window.__markdownTraceEvents = []
    let clipboardText = ""
    let copyDuringPending = false
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { clipboardText = text } },
    })
    const disposeOversizedCode = render(
      () => <Markdown text={oversizedCode()} cacheKey="oversized-fenced-code-fallback" />,
      oversizedCodeElement,
    )
    await frame()
    await frame()
    const coldCodeWorkerJobs = (window.__markdownTraceEvents ?? []).filter((event) => event.phase === "worker").length
    const coldCodeHasBlock = !!oversizedCodeElement.querySelector("[data-markdown-block]")
    maxFrameGapMs = 0
    oversizedCodeElement.style.opacity = "1"
    let codeFrames = 0
    while (
      codeFrames < 1800 &&
      (textContent(oversizedCodeElement).length !== oversizedCodeBody.length || markdownDomCommitSnapshot().queuedJobs > 0 || !clipboardText)
    ) {
      const copy = oversizedCodeElement.querySelector<HTMLElement>('[data-slot="markdown-copy-button"]')
      const pending = !!copy?.closest("[data-markdown-pending]")
      if (pending && !clipboardText) {
        copyDuringPending = true
        copy.click()
      }
      await frame()
      codeFrames++
    }
    const oversizedCodeVisible =
      textContent(oversizedCodeElement).length === oversizedCodeBody.length &&
      textContent(oversizedCodeElement).includes("oversized-code-marker") &&
      markdownDomCommitSnapshot().queuedJobs === 0
    const oversizedCodeTextLength = textContent(oversizedCodeElement).length
    const codeShell = !!oversizedCodeElement.querySelector('[data-component="markdown-code"]')
    const copyControl = !!oversizedCodeElement.querySelector('[data-slot="markdown-copy-button"]')
    disposeOversizedCode()
    await frame()
    results.push({
      scenario: "oversized-fenced-code-fallback",
      inputBytes: oversizedCodeSource.length * 2,
      overPerJobLimit: oversizedCodeSource.length * 2 > 8 * 1024 * 1024,
      expectedTextLength: oversizedCodeBody.length,
      outputTextLength: oversizedCodeTextLength,
      codeShell,
      copyControl,
      copyWasPending: copyDuringPending && clipboardText === oversizedCodeBody,
      clipboardTextLength: clipboardText.length,
      clipboardExact: clipboardText === oversizedCodeBody,
      markerVisible: oversizedCodeVisible,
      coldHiddenWorkerJobs: coldCodeWorkerJobs,
      coldHiddenHasContentBlock: coldCodeHasBlock,
      maximumFrameGapMs: Number(maxFrameGapMs.toFixed(2)),
      domCommit: markdownDomCommitSnapshot(),
      frameWork: markdownFrameWorkSnapshot(),
      teardownMarkdownRoots: root.querySelectorAll("[data-component='markdown']").length,
    })
    return results
  },
}
