import { createHash } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { createServer as createNetServer } from "node:net"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import { join, relative, resolve, sep } from "node:path"
import { promisify } from "node:util"
import appPlugins from "../../app/vite.js"
import { createServer as createViteServer } from "vite"
import { expect, test } from "bun:test"

const execFileAsync = promisify(execFile)
const desktopRoot = resolve(import.meta.dir, "..")
const opencodeRoot = resolve(import.meta.dir, "../../opencode")
const repoRoot = resolve(import.meta.dir, "../../..")
const password = "full-app-startup-gate-only"
const within = (parent: string, leaf: string) => join(parent, leaf)

// Test-only probes expose the real shared reducer store and timeline selectors
// to the fixture. They are injected into the Vite-served source at build time;
// no application source or runtime feature flag is changed.
const fullAppDiagnostics = {
  name: "full-app-gate-session-diagnostics",
  enforce: "pre" as const,
  transform(source: string, id: string) {
    const cleanID = id.split("?")[0]
    const normalizedID = cleanID!.replaceAll("\\", "/").replace(/^\/@fs\//, "").replace(/^\/(?=[A-Za-z]:\/)/, "")
    const appModule = normalizedID.match(/\/packages\/(app|ui)\/src\/(.+)$/)
    const isScript = /\.[cm]?[jt]sx?$/i.test(normalizedID)
    const dependencyModule = normalizedID.includes("/node_modules/") || normalizedID.includes("/vite-cache/deps/") || normalizedID.endsWith("/@vite/client")
    const gateEntry = normalizedID.endsWith("/packages/desktop/test/full-app-startup-gate/main.tsx")
    const measuredModule = process.env.OPENFORK_FULL_APP_GATE_PROFILE_STARTUP === "1" && isScript && (appModule || dependencyModule || gateEntry)
      ? appModule
        ? `${appModule[1]}/${appModule[2]}`
        : gateEntry
          ? "test/full-app-startup-gate/main.tsx"
          : normalizedID.includes("/vite-cache/deps/")
            ? `vite-cache/deps/${normalizedID.split("/vite-cache/deps/").at(-1)}`
            : `dependency/${normalizedID.split("/node_modules/").at(-1) ?? normalizedID}`
      : undefined
    if (measuredModule) {
      const label = measuredModule
      source = `if (typeof window !== "undefined") window.__fullAppGateModuleMark?.("start", ${JSON.stringify(label)})\n${source}\nif (typeof window !== "undefined") window.__fullAppGateModuleMark?.("end", ${JSON.stringify(label)})\n`
    }
    if (normalizedID.endsWith("/packages/session-ui/src/components/markdown.tsx")) {
      const needle = "  let copyCleanup: (() => void) | undefined"
      if (!source.includes(needle)) throw new Error("full-app gate Markdown diagnostic seam moved")
      source = source.replace(needle, `  createEffect(() => {
    const element = root()
    if (!element) return
    element.dataset.fullAppGatePacedChars = String(local.text.length)
    element.dataset.fullAppGateMarkdownVisible = String(visible())
    element.dataset.fullAppGateProjectionChars = String(projection.latest?.text.length ?? 0)
    element.dataset.fullAppGateHtmlChars = String(html.latest?.text.length ?? 0)
    element.dataset.fullAppGateHtmlComplete = String(html.latest?.complete)
  })
${needle}`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/pages/session.tsx")) {
      const scrollIntentNeedle = "!location.hash && !store.messageId && !ui.pendingMessage && !autoScroll.userScrolled()"
      if (!source.includes(scrollIntentNeedle)) throw new Error("full-app gate scroll-intent diagnostic seam moved")
      source = source.replace(scrollIntentNeedle, `(() => {
        const state = { at: performance.now(), hash: location.hash, messageID: store.messageId, pendingMessage: ui.pendingMessage, userScrolled: autoScroll.userScrolled() }
        ;(window as any).__fullAppGateScrollIntent = state
        return !state.hash && !state.messageID && !state.pendingMessage && !state.userScrolled
      })()`)
      const moduleMarker = `if (typeof window !== "undefined") {
  const modules = ((window as any).__fullAppGateLoadedModules ??= []) as string[]
  if (!modules.includes("session.tsx:SessionPage")) modules.push("session.tsx:SessionPage")
}
`
      if (!source.includes("session.tsx:SessionPage")) source = `${moduleMarker}${source}`
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/context/server-sdk.tsx")) {
      const gapRepairNeedle = "repairActiveSessionContentAfterGap([...streamSessionSet], streamContentInvalidator)"
      if (!source.includes(gapRepairNeedle)) throw new Error("full-app gate active-interest replay-gap seam moved")
      source = source.replace(gapRepairNeedle, `(() => {
        const active = [...streamSessionSet]
        ;((window as any).__fullAppGateGapRepairCalls ??= []).push(active)
        repairActiveSessionContentAfterGap(active, streamContentInvalidator)
      })()`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/context/server-sync.tsx")) {
      const bootstrapNeedle = "async function bootstrapInstance(directory: string) {"
      if (!source.includes(bootstrapNeedle)) throw new Error("full-app gate workspace-bootstrap diagnostic seam moved")
      source = source.replace(bootstrapNeedle, `${bootstrapNeedle}
    if (typeof window !== "undefined") {
      ;((window as any).__fullAppGateBootstrapDirectories ??= []).push({ directory, at: performance.now(), stack: new Error("workspace bootstrap owner").stack })
    }`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/context/sdk.tsx")) {
      const sdkNeedle = "      return serverSDK().ensureDirSdkContext(directory)"
      if (!source.includes(sdkNeedle)) throw new Error("full-app gate SDK location diagnostic seam moved")
      source = source.replace(sdkNeedle, `      if (directory === "global" && typeof window !== "undefined") {
        ;((window as any).__fullAppGateGlobalSDKProviders ??= []).push({ at: performance.now(), stack: new Error("global SDK provider").stack })
      }
${sdkNeedle}`)
      return { code: source, map: null }
    }
    const routeModule = normalizedID.endsWith("/packages/app/src/pages/draft-route.tsx")
      ? "draft-route.tsx"
      : normalizedID.endsWith("/packages/app/src/pages/new-session.tsx")
        ? "new-session.tsx"
        : normalizedID.endsWith("/packages/app/src/pages/new-session-enhanced.tsx")
          ? "new-session-enhanced.tsx"
          : /\/pages\/session\/composer\/session-composer-(region|state|region-controller)\.tsx?$/.test(normalizedID)
            ? normalizedID.split("/").at(-1)
        : undefined
    if (routeModule) {
      if (routeModule === "draft-route.tsx") {
        const importNeedle = 'const NewSession = lazy(() => import("@/pages/new-session"))'
        if (!source.includes(importNeedle)) throw new Error("full-app gate draft import diagnostic seam moved")
        source = source.replace(importNeedle, `const NewSession = lazy(() => {
  if (typeof window !== "undefined") performance.mark("full-app-gate:new-session-import-start")
  return import("@/pages/new-session").then((module) => {
    if (typeof window !== "undefined") performance.mark("full-app-gate:new-session-import-resolved")
    return module
  })
})`)
      }
      if (routeModule === "new-session.tsx") {
        const featureImport = 'const NewSessionEnhanced = lazy(() => import("@/pages/new-session-enhanced"))'
        if (!source.includes(featureImport)) throw new Error("full-app gate new-session feature-import diagnostic seam moved")
        source = source.replace(featureImport, `const NewSessionEnhanced = lazy(() => new Promise((resolve, reject) => {
  if (typeof window === "undefined") return import("@/pages/new-session-enhanced").then(resolve, reject)
  const gate = window as any
  gate.__fullAppGateEnhancedRequestCount = (gate.__fullAppGateEnhancedRequestCount ?? 0) + 1
  gate.__fullAppGateReleaseNewSessionFeatures = () => {
    performance.mark("full-app-gate:new-session-enhanced-import-start")
    return import("@/pages/new-session-enhanced").then((module) => {
      performance.mark("full-app-gate:new-session-enhanced-import-resolved")
      resolve(module)
    }, reject)
  }
  performance.mark("full-app-gate:new-session-features-held")
}))`)
      }
      const moduleMarker = `if (typeof window !== "undefined") {
  const modules = ((window as any).__fullAppGateLoadedModules ??= []) as string[]
  if (!modules.includes(${JSON.stringify(routeModule)})) modules.push(${JSON.stringify(routeModule)})
  performance.mark("full-app-gate:module:${routeModule}")
}
`
      return { code: `${moduleMarker}${source}`, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/context/global-sync/child-store.ts")) {
      const childNeedle = "function ensureChild(directory: string) {"
      if (!source.includes(childNeedle)) throw new Error("full-app gate child-location diagnostic seam moved")
      source = source.replace(childNeedle, `${childNeedle}
    if (directory === "global" && typeof window !== "undefined") {
      ;((window as any).__fullAppGateGlobalChildCalls ??= []).push({ at: performance.now(), stack: new Error("global child creation").stack })
    }`)
      const childFailureNeedle = 'if (!childStore) throw new Error(input.translate("error.childStore.storeCreateFailed"))'
      if (!source.includes(childFailureNeedle)) throw new Error("full-app gate child-store diagnostic seam moved")
      source = source.replace(childFailureNeedle, `if (!childStore) {
        const details = { directory, key, keys: Object.keys(children), ownerPresent: !!input.owner, currentOwnerPresent: !!getOwner(), vcsCached: vcsCache.has(key), metaCached: metaCache.has(key), iconCached: iconCache.has(key) }
        if (typeof window !== "undefined") ((window as any).__fullAppGateChildStoreErrors ??= []).push(details)
        throw new Error(input.translate("error.childStore.storeCreateFailed") + ": " + JSON.stringify(details))
      }`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/context/server-session.ts")) {
      const storeNeedle = "  return {\n    data,\n    inspectMessageParts,"
      const eventNeedle = "  const apply = (event: { type: string; properties?: unknown }) => {"
      const v2Needle = "  const applyV2 = (event: SessionStreamEvent) => {"
      if (!source.includes(storeNeedle) || !source.includes(eventNeedle) || !source.includes(v2Needle)) {
        throw new Error("full-app gate server-session diagnostic seam moved")
      }
      source = source.replace(eventNeedle, `${eventNeedle}
    if (typeof window !== "undefined") {
      const properties = event.properties as { sessionID?: string; info?: Record<string, unknown>; part?: Record<string, unknown>; messageID?: string; partID?: string } | undefined
      const log = ((window as any).__fullAppGateApplyEvents ??= []) as unknown[]
      if (["message.updated", "message.part.updated", "message.part.delta", "session.next.prompted", "session.next.synthetic"].includes(event.type)) log.push({
        phase: "legacy-apply",
        type: event.type,
        sessionID: properties?.sessionID ?? (properties?.info?.sessionID as string | undefined) ?? (properties?.part?.sessionID as string | undefined),
        messageID: properties?.messageID ?? (properties?.info?.id as string | undefined) ?? (properties?.part?.messageID as string | undefined),
        partID: properties?.partID ?? (properties?.part?.id as string | undefined),
        role: properties?.info?.role,
        parentID: properties?.info?.parentID,
        provenance: properties?.info?.provenance,
        kind: properties?.info?.kind,
        prompt: (properties as any)?.prompt,
        synthetic: (properties as any)?.text,
      })
    }`)
      source = source.replace(v2Needle, `${v2Needle}
    if (typeof window !== "undefined" && ["session.next.prompted", "session.next.synthetic"].includes(event.type)) {
      const log = ((window as any).__fullAppGateApplyEvents ??= []) as unknown[]
      log.push({ phase: "v2-apply", type: event.type, sessionID: (event as any).data?.sessionID, messageID: (event as any).data?.messageID, provenance: (event as any).data?.provenance, prompt: (event as any).data?.prompt, synthetic: (event as any).data?.text })
    }`)
      source = source.replace(storeNeedle, `  if (typeof window !== "undefined") {
    const readers = ((window as any).__fullAppGateSessionReaders ??= []) as Array<(sessionID: string) => any>
    readers.push((sessionID: string) => ({
      messages: (data.message[sessionID] ?? []).map((message) => ({
        id: message.id, sessionID: message.sessionID, role: message.role, parentID: message.parentID,
        provenance: (message as any).provenance, kind: (message as any).kind,
        parts: (data.part[message.id] ?? []).map((part) => ({
          id: part.id, messageID: part.messageID, type: part.type, text: (part as any).text,
          textDeltaLength: data.part_text_accum_delta[part.id]?.length,
          textDeltaPreview: data.part_text_accum_delta[part.id]?.slice(0, 120),
        })),
      })),
      messageWindow: data.message_window,
      sessionMessages: data.session_message[sessionID] ?? [],
      status: data.session_status[sessionID],
    }))
    ;(window as any).__fullAppGateReadServerSession = (sessionID: string) => {
      const snapshots = readers.map((reader) => reader(sessionID))
      return snapshots.findLast((snapshot) => snapshot.messages.length > 0) ?? snapshots.at(-1)
    }
    ;(window as any).__fullAppGateReadLiveReasoning = (sessionID: string) => {
      const messages = data.message[sessionID] ?? []
      const message = messages.at(-1)
      if (!message) return undefined
      return {
        messageID: message.id,
        parts: (data.part[message.id] ?? []).filter((part) => part.type === "reasoning").map((part) => ({
          id: part.id,
          textChars: typeof (part as any).text === "string" ? (part as any).text.length : 0,
          deltaChars: data.part_text_accum_delta[part.id]?.length,
        })),
      }
    }
    ;(window as any).__fullAppGateInjectParts = (sessionID: string, messageID: string, count: number) => {
      if (!data.message[sessionID]?.some((message) => message.id === messageID)) {
        throw new Error("full-app gate part target is not owned by this session store")
      }
      const parts = Array.from({ length: count }, (_, index) => ({
        id: "gate-large-part-" + String(index).padStart(8, "0"),
        sessionID,
        messageID,
        type: "text",
        text: "large-part-" + index,
      }))
      setData("part", messageID, parts as any)
    }
    ;(window as any).__fullAppGateInjectRunningTool = (sessionID: string, messageID: string, output: string) => {
      if (!data.message[sessionID]?.some((message) => message.id === messageID)) throw new Error("tool fixture owner is not loaded")
      const partID = "prt_gate_running_tool_output"
      apply({ type: "message.part.updated", properties: { part: {
        id: partID, sessionID, messageID, type: "tool", tool: "shell", callID: "gate-running-tool",
        state: { status: "running", input: { command: "printf gate-running-output" },
          title: "gate-running-output", metadata: { output }, time: { start: Date.now() } },
      } } })
      return () => apply({ type: "message.part.removed", properties: { sessionID, messageID, partID } })
    }
  }
${storeNeedle}`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/pages/session/timeline/model.ts")) {
      const userMessagesNeedle = "  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })"
      if (!source.includes(userMessagesNeedle)) throw new Error("full-app gate semantic-user scan seam moved")
      source = source.replace(userMessagesNeedle, `  const userMessages = createMemo(() => {
    const sourceMessages = messages()
    ;(window as any).__fullAppGateReactiveWork?.count("timelineSemanticUserScanCalls")
    ;(window as any).__fullAppGateReactiveWork?.count("timelineSemanticUserScanVisits", sourceMessages.length)
    return selectUserMessages(sourceMessages)
  }, emptyUserMessages, { equals: (a, b) => (window as any).__fullAppGateReactiveWork?.sameSemanticUsers("timelineUserEquality", a, b) ?? same(a, b) })`)
      const equalityOptions = /\{\s*equals:\s*same\s*\}/g
      if (!equalityOptions.test(source)) throw new Error("full-app gate semantic-user equality seam moved")
      source = source.replace(equalityOptions, `{ equals: (a, b) => (window as any).__fullAppGateReactiveWork?.sameSemanticUsers("timelineUserEquality", a, b) ?? same(a, b) }`)
      const predicateNeedle = "  return messages.filter(isSemanticUserMessage)"
      if (!source.includes(predicateNeedle)) throw new Error("full-app gate semantic-user predicate seam moved")
      source = source.replace(predicateNeedle, `  return messages.filter((message) => {
    ;(window as any).__fullAppGateReactiveWork?.count("timelineSemanticUserPredicateChecks")
    return isSemanticUserMessage(message)
  })`)
      const timelineNeedle = "  const more = createMemo(() => {"
      if (!source.includes(timelineNeedle)) throw new Error("full-app gate timeline diagnostic seam moved")
      source = source.replace(timelineNeedle, `  if (typeof window !== "undefined") {
    const readers = ((window as any).__fullAppGateTimelineReaders ??= []) as Array<() => any>
    const read = () => ({
      sessionID: input.sessionID(),
      messages: messages().map((message) => ({ id: message.id, role: message.role, parentID: message.parentID, provenance: (message as any).provenance, kind: (message as any).kind })),
      userMessages: userMessages().map((message) => ({ id: message.id, role: message.role, parentID: message.parentID, provenance: (message as any).provenance, kind: (message as any).kind })),
      visibleUserMessages: visibleUserMessages().map((message) => ({ id: message.id, role: message.role, parentID: message.parentID, provenance: (message as any).provenance, kind: (message as any).kind })),
      ready: ready(),
    })
    readers.push(read)
    ;(window as any).__fullAppGateReadTimeline = (sessionID: string) => readers.map((reader) => reader()).find((snapshot) => snapshot.sessionID === sessionID)
  }
${timelineNeedle}`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/pages/session/timeline/message-timeline.tsx")) {
      const rendererNeedle = "  let estimateInputCache = new WeakMap<"
      if (!source.includes(rendererNeedle)) throw new Error("full-app gate MessageTimeline diagnostic seam moved")
      source = source.replace(rendererNeedle, `  if (typeof window !== "undefined") {
    const readers = ((window as any).__fullAppGateTimelineRendererReaders ??= []) as Array<() => any>
    const read = () => ({
      sessionID: sessionID(),
      shouldAnchorBottom: props.shouldAnchorBottom(),
      scrollIntent: (window as any).__fullAppGateScrollIntent,
      hasScrollGesture: props.hasScrollGesture(),
      userMessages: props.userMessages.map((message) => ({ id: message.id, role: message.role, provenance: (message as any).provenance })),
      sessionMessages: sessionMessages().map((message) => ({ id: message.id, type: message.type })),
      projectedMessages: projectedMessages().map((message) => ({ id: message.id, type: message.type })),
      timelineRows: safeTimelineRows().map((row) => ({ tag: row._tag, key: TimelineRow.key(row) })),
      virtualRowKeys: virtualRowKeys(),
      virtualRange: virtualizer.range,
      totalSize: virtualizer.getTotalSize(),
      listRoot: (() => {
        const element = listRoot()
        if (!element) return undefined
        const rect = element.getBoundingClientRect()
        return {
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        }
      })(),
      visibleAnchor: (() => {
        const root = listRoot()
        if (!root) return undefined
        const bounds = root.getBoundingClientRect()
        for (const element of document.querySelectorAll<HTMLElement>("[data-timeline-key]")) {
          const rect = element.getBoundingClientRect()
          if (rect.bottom > bounds.top && rect.top < bounds.bottom) {
            return { key: element.dataset.timelineKey, top: rect.top - bounds.top }
          }
        }
        return undefined
      })(),
      viewport: {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        outerWidth: window.outerWidth,
        outerHeight: window.outerHeight,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        rootClientWidth: document.documentElement.clientWidth,
        rootClientHeight: document.documentElement.clientHeight,
        html: (() => {
          const element = document.documentElement
          const rect = element.getBoundingClientRect()
          return { className: element.className, clientWidth: element.clientWidth, clientHeight: element.clientHeight, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
        })(),
        body: (() => {
          const element = document.body
          const rect = element.getBoundingClientRect()
          return { className: element.className, clientWidth: element.clientWidth, clientHeight: element.clientHeight, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
        })(),
        appRoot: (() => {
          const element = document.getElementById("root")
          const rect = element?.getBoundingClientRect()
          return { className: element?.className, clientWidth: element?.clientWidth, clientHeight: element?.clientHeight, rect: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height } }
        })(),
      },
      listAncestors: (() => {
        const chain = []
        let element: HTMLElement | null = listRoot() ?? null
        while (element && chain.length < 40) {
          const style = getComputedStyle(element)
          const rect = element.getBoundingClientRect()
          chain.push({
            tag: element.tagName,
            id: element.id,
            className: typeof element.className === "string" ? element.className.slice(0, 240) : "",
            component: element.dataset.component,
            slot: element.dataset.slot,
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            offsetWidth: element.offsetWidth,
            offsetHeight: element.offsetHeight,
            scrollTop: element.scrollTop,
            scrollHeight: element.scrollHeight,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom },
            display: style.display,
            visibility: style.visibility,
            position: style.position,
            flex: style.flex,
            flexBasis: style.flexBasis,
            flexGrow: style.flexGrow,
            flexShrink: style.flexShrink,
            minHeight: style.minHeight,
            maxHeight: style.maxHeight,
            height: style.height,
            overflow: style.overflow,
            overflowY: style.overflowY,
          })
          element = element.parentElement
        }
        return chain
      })(),
      virtualContent: virtualContent ? { clientHeight: virtualContent.clientHeight, styleHeight: virtualContent.style.height } : undefined,
    })
    readers.push(read)
    ;(window as any).__fullAppGateReadTimelineRenderer = (sessionID: string) => readers.map((reader) => reader()).find((snapshot) => snapshot.sessionID === sessionID)
    const countReaders = ((window as any).__fullAppGateTimelineCountReaders ??= []) as Array<() => any>
    countReaders.push(() => ({ sessionID: sessionID(), rows: safeTimelineRows().length, virtualRows: virtualRowKeys().length }))
    ;(window as any).__fullAppGateReadTimelineCounts = (targetSessionID: string) => countReaders.map((reader) => reader()).find((snapshot) => snapshot.sessionID === targetSessionID)
    ;(window as any).__fullAppGateScrollTimeline = async (targetSessionID: string, direction: "up" | "bottom") => {
      if (sessionID() !== targetSessionID) throw new Error("full-app gate scroll target is not the active Session")
      const element = listRoot()
      if (!element) throw new Error("full-app gate timeline scroll root is missing")
      const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (direction === "up") {
        // A short diagnostic viewport makes an actual scroll-up possible in
        // this compact fixture without changing application behavior.
        element.style.height = "120px"
        element.style.maxHeight = "120px"
        element.style.flex = "0 0 120px"
        await frame()
        await frame()
        const max = Math.max(0, virtualizer.getTotalSize() - element.clientHeight)
        element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1, pointerId: 1, pointerType: "mouse" }))
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -element.clientHeight }))
        element.scrollTop = Math.max(0, max - element.clientHeight)
        element.dispatchEvent(new Event("scroll"))
      } else {
        element.style.removeProperty("height")
        element.style.removeProperty("max-height")
        element.style.removeProperty("flex")
        // Removing the diagnostic viewport and synchronously assigning the
        // old virtual size can land short of the true bottom while row
        // measurements are still settling. Keep following the current total
        // through several frames, and require the timeline's own anchor state
        // to converge before the next streaming scenario starts.
        let stableBottomFrames = 0
        for (let attempt = 0; attempt < 30 && stableBottomFrames < 3; attempt++) {
          await frame()
          element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight)
          element.dispatchEvent(new Event("scroll"))
          await frame()
          const atBottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 2
          stableBottomFrames = atBottom && read().shouldAnchorBottom ? stableBottomFrames + 1 : 0
        }
        if (stableBottomFrames < 3) {
          throw new Error("full-app gate could not restore timeline tail: " + JSON.stringify(read().listRoot))
        }
      }
      await frame()
      return read().listRoot
        ? {
            ...read().listRoot,
            visibleAnchor: read().visibleAnchor,
            virtualSize: virtualizer.getTotalSize(),
            maxScroll: Math.max(0, virtualizer.getTotalSize() - element.clientHeight),
            clientHeight: element.clientHeight,
          }
        : {}
    }
  }
${rendererNeedle}`)
      const resizeNeedle = "  const applyResize = (index: number, size: number, expectedKey?: ResizeKey) => {"
      if (!source.includes(resizeNeedle)) throw new Error("full-app gate timeline resize trace seam moved")
      source = source.replace(resizeNeedle, `${resizeNeedle}
    performance.mark("full-app-gate:timeline:resize-begin")`)
      const resizeCommitNeedle = "    resizeItem(index, size)"
      if (!source.includes(resizeCommitNeedle)) throw new Error("full-app gate timeline resize commit seam moved")
      source = source.replace(resizeCommitNeedle, `    performance.mark("full-app-gate:timeline:resize-commit")
${resizeCommitNeedle}`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/pages/session/use-session-commands.tsx")) {
      const eligibilityNeedle = "actions.hasVisibleUserMessage()"
      if (!source.includes(eligibilityNeedle)) throw new Error("full-app gate shared command eligibility seam moved")
      source = source.replaceAll(eligibilityNeedle, `((window as any).__fullAppGateReactiveWork?.count("commandEligibilityChecks"), actions.hasVisibleUserMessage())`)
      if (source.includes("isSemanticUserMessage") || source.includes("data.message")) {
        throw new Error("session commands must consume the timeline projection instead of scanning message history")
      }
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/pages/session/timeline/projection.ts")) {
      const mapNeedle = "    const assistantViewByID = createMemo(() => new Map(assistantViews().map((view) => [view.id, view] as const)))"
      if (!source.includes(mapNeedle)) throw new Error("full-app gate assistant-view map seam moved")
      source = source.replace(mapNeedle, `    const assistantViewByID = createMemo(() => {
      const views = assistantViews()
      ;(window as any).__fullAppGateReactiveWork?.count("assistantViewMapRebuilds")
      ;(window as any).__fullAppGateReactiveWork?.count("assistantViewMapEntries", views.length)
      return new Map(views.map((view) => [view.id, view] as const))
    })`)
      return { code: source, map: null }
    }
    if (normalizedID.endsWith("/packages/app/src/context/server-sdk.tsx")) {
      const startedNeedle = "    const flushStartedAt = performance.now()"
      const eventNeedle = "      processed = drainServerEventQueue(queue, event => {"
      const endedNeedle = "    const flushMs = Math.max(0, performance.now() - flushStartedAt)"
      for (const [needle, label] of [[startedNeedle, "flush start"], [eventNeedle, "queue event"], [endedNeedle, "flush end"]] as const) {
        if (!source.includes(needle)) {
          const nearby = source.split(/\r?\n/).filter((line) => /drainServerEventQueue|emitter|payload\.type|flushStartedAt/.test(line)).slice(0, 16)
          throw new Error(`full-app gate ${label} instrumentation seam moved; nearby=${JSON.stringify(nearby)}`)
        }
      }
      source = source.replace(startedNeedle, `${startedNeedle}
    const gateFlushID = (window as any).__fullAppGateReactiveWork?.beginFlush()`)
      source = source.replace(eventNeedle, `${eventNeedle}
        ;(window as any).__fullAppGateReactiveWork?.event(gateFlushID, String(event.payload.type), serverEventSessionID(event.payload))`)
      source = source.replace(endedNeedle, `${endedNeedle}
    ;(window as any).__fullAppGateReactiveWork?.endFlush(gateFlushID, processed, flushMs)`)
      return { code: source, map: null }
    }
    if (measuredModule) return { code: source, map: null }
    return
  },
}

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,authorization" })
  response.end(JSON.stringify(body))
}

function body(request: IncomingMessage) {
  return new Promise<string>((resolveBody, reject) => {
    let value = ""
    request.setEncoding("utf8")
    request.on("data", (chunk) => (value += chunk))
    request.once("end", () => resolveBody(value))
    request.once("error", reject)
  })
}

function modelServer() {
  const pending = new Map<string, ServerResponse>()
  let scanArrivals = 0
  let scanReleaseRequested = false
  let scanWaitResponse: ServerResponse | undefined
  const reasoningRuns = new Map<string, {
    key: string
    sessionID: string
    chunksWritten: number
    startedAt: number
    chunkTimes: number[]
    closedAt?: number
    finishedAt?: number
    response: ServerResponse
  }>()
  const observations: Array<{ key?: string; markerFound: boolean; path: string; model?: string; messages: Array<{ role?: string; content: string }> }> = []
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" })
      response.end()
      return
    }
    if (url.pathname === "/gate/scan/status" && request.method === "GET") {
      send(response, 200, { arrivals: scanArrivals, held: !!scanWaitResponse, releaseRequested: scanReleaseRequested })
      return
    }
    if (url.pathname === "/gate/scan/wait" && request.method === "GET") {
      scanArrivals += 1
      if (scanReleaseRequested) {
        send(response, 200, { released: true })
        return
      }
      if (scanWaitResponse) {
        send(response, 409, { error: "only one usage scan may be held" })
        return
      }
      scanWaitResponse = response
      response.once("close", () => {
        if (scanWaitResponse === response) scanWaitResponse = undefined
      })
      return
    }
    if (url.pathname === "/gate/scan/release" && request.method === "POST") {
      scanReleaseRequested = true
      const held = scanWaitResponse
      scanWaitResponse = undefined
      if (held && !held.destroyed && !held.writableEnded) {
        send(held, 200, { released: true })
      }
      send(response, 200, { arrivals: scanArrivals, released: !!held })
      return
    }
    if (url.pathname === "/gate/reasoning/status" && request.method === "GET") {
      send(response, 200, [...reasoningRuns.values()].map(({ response: _response, ...run }) => run))
      return
    }
    if (url.pathname === "/gate/reasoning/start" && request.method === "POST") {
      void body(request).then((raw) => {
        const input = JSON.parse(raw) as {
          sessions: Array<{ id: string; cycle: number; chunks: number; chunkChars: number; intervalMs: number }>
        }
        if (!Array.isArray(input.sessions) || input.sessions.length < 1 || input.sessions.length > 6 || input.sessions.some((item) =>
          !/^ses_[A-Za-z0-9_-]+$/.test(item.id) || !Number.isSafeInteger(item.cycle) ||
          !Number.isSafeInteger(item.chunks) || item.chunks < 2 || item.chunks > 1000 ||
          !Number.isSafeInteger(item.chunkChars) || item.chunkChars < 128 || item.chunkChars > 4096 ||
          !Number.isSafeInteger(item.intervalMs) || item.intervalMs < 5 || item.intervalMs > 100,
        )) throw new Error("invalid reasoning stream fixture request")
        const deadline = Date.now() + 15_000
        const awaitAll = () => new Promise<void>((resolvePending) => {
          const poll = () => {
            if (input.sessions.every(({ id, cycle }) => pending.has(`${id}:${cycle}`)) || Date.now() >= deadline) return resolvePending()
            setTimeout(poll, 20)
          }
          poll()
        })
        void awaitAll().then(() => {
          const missing = input.sessions.filter(({ id, cycle }) => !pending.has(`${id}:${cycle}`)).map(({ id, cycle }) => `${id}:${cycle}`)
          if (missing.length) return send(response, 408, { missing })
          const started = [] as string[]
          const now = Date.now()
          for (const session of input.sessions) {
            const key = `${session.id}:${session.cycle}`
            const held = pending.get(key)!
            pending.delete(key)
            const run = { key, sessionID: session.id, chunksWritten: 0, startedAt: now, chunkTimes: [], response: held }
            reasoningRuns.set(key, run)
            held.once("close", () => { run.closedAt = Date.now() })
            held.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`)
            const writeReasoning = (index: number) => {
              if (held.destroyed || held.writableEnded) return false
              const marker = `reasoning-${session.id}-chunk-${index}-`
              const content = marker + "x".repeat(Math.max(0, session.chunkChars - marker.length))
              held.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { reasoning_content: content }, finish_reason: null }] })}\n\n`)
              run.chunksWritten = index + 1
              run.chunkTimes[index] = Date.now()
              return true
            }
            writeReasoning(0)
            const pump = (index: number) => {
              if (held.destroyed || held.writableEnded) return
              if (index >= session.chunks) {
                held.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
                held.end("data: [DONE]\n\n")
                run.finishedAt = Date.now()
                return
              }
              setTimeout(() => {
                if (writeReasoning(index)) pump(index + 1)
              }, session.intervalMs)
            }
            pump(1)
            started.push(key)
          }
          send(response, 200, { started, at: now })
        })
      }, (error) => send(response, 400, { error: String(error) }))
      return
    }
    if (url.pathname === "/gate/release" && request.method === "POST") {
      void body(request).then((raw) => {
        const sessions = (JSON.parse(raw) as { sessions: Array<{ id: string; cycle: number }> }).sessions
        const deadline = Date.now() + 15_000
        const awaitAll = () => new Promise<void>((resolvePending) => {
          const poll = () => {
            if (sessions.every(({ id, cycle }) => pending.has(`${id}:${cycle}`)) || Date.now() >= deadline) return resolvePending()
            setTimeout(poll, 20)
          }
          poll()
        })
        void awaitAll().then(() => {
        const released: string[] = []
        const missing: string[] = []
        for (const { id, cycle } of sessions) {
          const key = `${id}:${cycle}`
          const held = pending.get(key)
          if (!held) { missing.push(key); continue }
          pending.delete(key)
          released.push(key)
          held.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `\n\n**full-app-gate-tail-${id}-cycle-${cycle}**` }, finish_reason: null }] })}\n\n`)
          held.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`)
          held.end("data: [DONE]\n\n")
        }
        send(response, 200, { released, missing, observations: [...observations] })
        })
      }, (error) => send(response, 400, { error: String(error) }))
      return
    }
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      send(response, 200, { data: [{ id: "gate-model", object: "model" }] })
      return
    }
    if (request.method !== "POST" || !url.pathname.endsWith("/chat/completions")) {
      send(response, 404, { error: "unexpected mock model request", path: url.pathname })
      return
    }
    void body(request).then((raw) => {
      const payload = JSON.parse(raw) as { messages?: Array<{ role?: string; content?: unknown }>; model?: string }
      const messages = payload.messages ?? []
      // A selected session's provider history contains older prompts. Key this
      // held response from the newest user message, not the first matching
      // marker anywhere in serialized history, or later cycles get misfiled.
      const newestUser = [...messages].reverse().find((message) => message.role === "user")
      const newestUserContent = typeof newestUser?.content === "string"
        ? newestUser.content
        : newestUser?.content === undefined ? "" : JSON.stringify(newestUser.content)
      const match = newestUserContent.match(/full-app-gate-(ses_[A-Za-z0-9_-]+?)-cycle-(\d+)/)
      const id = match?.[1]
      const cycle = Number(match?.[2])
      observations.push({
        key: id ? `${id}:${cycle}` : undefined,
        markerFound: !!id,
        path: url.pathname,
        model: payload.model,
        messages: messages.slice(-4).map((message) => ({
          role: message.role,
          content: typeof message.content === "string" ? message.content.slice(-500) : message.content == null ? "" : JSON.stringify(message.content).slice(-500),
        })),
      })
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" })
      response.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`)
      if (!id) { response.end("data: [DONE]\n\n"); return }
      response.write(`data: ${JSON.stringify({ id: "full-app-gate", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: `full-app-gate-start-${id}` }, finish_reason: null }] })}\n\n`)
      pending.set(`${id}:${cycle}`, response)
    }, (error) => send(response, 400, { error: String(error) }))
  })
  return {
    server,
    pending,
    observations,
    close: async () => {
      for (const response of pending.values()) response.destroy()
      pending.clear()
      if (scanWaitResponse && !scanWaitResponse.destroyed) scanWaitResponse.destroy()
      scanWaitResponse = undefined
      server.closeAllConnections()
      if (server.listening) await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
    },
  }
}

async function privatePort() {
  const reservation = createNetServer()
  await new Promise<void>((resolveListen, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolveListen)
  })
  try {
    const address = reservation.address()
    if (!address || typeof address === "string" || address.port === 5173) throw new Error("failed to reserve a private renderer port")
    return address.port
  } finally {
    if (reservation.listening) {
      await new Promise<void>((resolveClose, reject) => reservation.close((error) => error ? reject(error) : resolveClose()))
    }
  }
}

const sourceFiles = [
  "packages/desktop/electron.vite.config.ts",
  "packages/desktop/src/main/sidecar.ts",
  "packages/desktop/src/main/sidecar-control-transport.ts",
  "packages/desktop/src/renderer/control-fetch.ts",
  "packages/app/src/utils/sidecar-control-request.ts",
  "packages/desktop/src/renderer/index.html",
  "packages/desktop/test/electron-fixture-profile.ts",
  "packages/desktop/test/electron-full-app-startup-gate.test.ts",
  "packages/desktop/test/full-app-startup-gate/main.ts",
  "packages/desktop/test/full-app-startup-gate/main.tsx",
  "packages/desktop/test/full-app-startup-gate/index.html",
  "packages/desktop/test/full-app-startup-gate/preload.ts",
  "packages/app/vite.js",
  "packages/app/src/app.tsx",
  "packages/app/src/app-session-routes.tsx",
  "packages/app/src/pages/layout-new.tsx",
  "packages/app/src/pages/home.tsx",
  "packages/app/src/pages/draft-route.tsx",
  "packages/app/src/pages/new-session-enhanced.tsx",
  "packages/app/src/pages/new-session/new-session-draft-controller.ts",
  "packages/app/src/pages/session/composer/index.ts",
  "packages/app/src/pages/session/composer/session-composer-controls.ts",
  "packages/app/src/pages/session/composer/human-interjection.ts",
  "packages/app/src/pages/session/composer/session-composer-region-controller.ts",
  "packages/app/src/pages/session/composer/session-composer-region.tsx",
  "packages/app/src/components/prompt-input/submit.ts",
  "packages/app/src/utils/session.ts",
  "packages/app/src/utils/server-compat.ts",
  "packages/app/src/pages/home/home-sessions-view.tsx",
  "packages/app/src/pages/new-session.tsx",
  "packages/app/src/pages/session.tsx",
  "packages/app/src/pages/home/home-sessions-controller.tsx",
  "packages/app/src/context/server-sync.tsx",
  "packages/app/src/context/server-sdk.tsx",
  "packages/app/src/context/notification.tsx",
  "packages/app/src/context/notification-session.ts",
  "packages/app/src/utils/path-key.ts",
  "packages/app/src/context/phase-trace.ts",
      "packages/app/src/context/server-session.ts",
      "packages/app/src/context/server-session-v2-reducer.ts",
      "packages/app/src/context/directory-sync.ts",
      "packages/app/src/utils/session-message.ts",
      "packages/app/src/utils/session-message-info.ts",
      "packages/app/src/pages/session/timeline/projection.ts",
      "packages/app/src/pages/session/timeline/row-index.ts",
      "packages/app/src/pages/session/timeline/model.ts",
  "packages/app/src/pages/session/timeline/message-timeline.tsx",
  "packages/app/src/pages/session/timeline/progressive-detail-fence.ts",
  "packages/opencode/src/session/message-v2.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/session-read.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/session-read.ts",
  "packages/sdk/js/src/v2/client.ts",
  "packages/sdk/js/src/v2/gen/sdk.gen.ts",
      "packages/session-ui/src/components/markdown.tsx",
  "packages/session-ui/src/components/markdown-large-render.ts",
  "packages/session-ui/src/components/markdown-large.worker.ts",
  "packages/session-ui/src/components/markdown-large-fragments.ts",
  "packages/session-ui/src/components/markdown-large-protocol.ts",
  "packages/session-ui/src/components/markdown-large-block.ts",
  "packages/session-ui/src/components/markdown-presentation.ts",
  "packages/session-ui/src/components/markdown-dom-commit.ts",
  "packages/session-ui/src/components/markdown-stream.ts",
  "packages/session-ui/src/components/markdown-frame-work.ts",
  "packages/session-ui/src/components/markdown-visibility.ts",
  "packages/session-ui/src/components/message-part.tsx",
  "packages/ui/src/hooks/create-auto-scroll.tsx",
  "packages/ui/src/hooks/auto-scroll-intent.ts",
  "packages/ui/src/components/scroll-view.tsx",
  "packages/core/src/session-stream-content.ts",
  "packages/core/src/database/sqlite.node.ts",
  "packages/core/src/database/database.ts",
  "packages/core/src/usage/sql.ts",
  "packages/opencode/src/usage/usage.ts",
  "packages/opencode/src/server/routes/instance/httpapi/api.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/usage.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/usage.ts",
  "packages/schema/src/session-event.ts",
  "packages/app/src/context/global-sync/bootstrap.ts",
  "packages/app/src/hooks/use-openrouter-free-usage.ts",
  "packages/app/src/hooks/use-limits/index.ts",
  "packages/opencode/src/server/shared/workspace-routing.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/experimental.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/openrouter-free-usage.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/experimental.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/openrouter-free-usage.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/project.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/project.ts",
  "packages/opencode/src/server/routes/instance/httpapi/groups/config.ts",
  "packages/opencode/src/server/routes/instance/httpapi/handlers/config.ts",
  "packages/opencode/src/server/routes/instance/httpapi/server.ts",
  "packages/opencode/src/project/project.ts",
  "packages/opencode/src/config/config.ts",
  "packages/opencode/src/project/instance-store.ts",
]

test("production desktop application keeps cold Home and background sessions on their owners", async () => {
  const runID = `${process.pid}-${crypto.randomUUID()}`
  // SQLite's Windows WAL/SHM companions append suffixes to a 64-hex global
  // file-index database name. Keep the retained fixture root compact so those
  // legitimate sidecar paths stay well below the Win32 path boundary.
  const fixture = await mkdtemp(join(import.meta.dir, `.fg-${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}-`))
  const workspace = within(fixture, "workspace")
  const dataRoot = within(fixture, "isolated-user-data")
  const nodeOut = within(fixture, "private-node-artifact")
  const buildScript = within(join(opencodeRoot, "script"), `build-node-full-app-gate-${runID}.ts`)
  const configPath = within(fixture, "electron-vite.config.ts")
  const electronOut = within(fixture, "electron-build")
  const evidencePath = within(fixture, "evidence.json")
  const traceRoot = within(fixture, "traces")
  const model = modelServer()
  let vite: Awaited<ReturnType<typeof createViteServer>> | undefined
  let modelPort: number | undefined
  let electronOutput = ""
  try {
    await mkdir(workspace, { recursive: true })
    await mkdir(dataRoot, { recursive: true })
    await mkdir(traceRoot, { recursive: true })
    await mkdir(nodeOut, { recursive: true })
    // The private ESM artifact is outside the package tree. Link the exact
    // external package it needs into this run-owned fixture. A junction to the
    // whole workspace node_modules would break Bun's relative per-package
    // symlinks, so resolve the package target before creating the link.
    const privateNodeModules = join(nodeOut, "node_modules")
    await mkdir(privateNodeModules)
    const jsoncPackageRoot = await realpath(join(opencodeRoot, "node_modules", "jsonc-parser"))
    const jsoncFixtureLink = join(privateNodeModules, "jsonc-parser")
    await symlink(jsoncPackageRoot, jsoncFixtureLink, "junction")
    if (await realpath(jsoncFixtureLink) !== jsoncPackageRoot) throw new Error("private jsonc-parser link did not resolve to its inspected package target")
    await execFileAsync("git", ["init", workspace], { timeout: 20_000 })
    await execFileAsync("git", ["-C", workspace, "config", "core.fsmonitor", "false"], { timeout: 15_000 })
    await new Promise<void>((resolveListen, reject) => model.server.listen(0, "127.0.0.1", (error) => error ? reject(error) : resolveListen()))
    const address = model.server.address()
    if (!address || typeof address === "string") throw new Error("private mock model server did not bind")
    modelPort = address.port
    await writeFile(join(workspace, "openfork.json"), JSON.stringify({
      formatter: false,
      lsp: false,
      provider: {
        "full-app-gate": {
          name: "Full application gate",
          npm: "@ai-sdk/openai-compatible",
          api: `http://127.0.0.1:${modelPort}/v1`,
          options: { apiKey: "full-app-gate-key" },
          models: { "gate-model": { name: "Gate model", reasoning: true, interleaved: "reasoning_content", limit: { context: 100000, output: 100000 } } },
        },
      },
    }))

    const nodeSource = await readFile(join(opencodeRoot, "script", "build-node.ts"), "utf8")
    const sources = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    const sourceFingerprint = createHash("sha256").update(JSON.stringify(sources)).digest("hex")
    const absoluteNodeOut = nodeOut.replaceAll("\\", "/")
    const buildInstrumentation = `
  const result = await Bun.build({
    ...options,
    plugins: [...(options.plugins ?? []), {
      name: "full-app-gate-instance-owner-trace",
      setup(build) {
        build.onLoad({ filter: /instance-store/ }, async ({ path }) => {
          const source = await Bun.file(path).text()
          const needle = 'yield* Effect.logInfo("creating instance", {'
          if (!source.includes(needle)) throw new Error("InstanceStore authoritative creation seam moved; update the full-app gate")
          const trace = 'process.stdout.write("FULL_APP_GATE_INSTANCE_LOAD " + JSON.stringify({ pid: process.pid, directory, explicitLocation: !!input.attribution, caller: input.attribution?.caller ?? "unspecified", route: input.attribution?.route, reason: input.attribution?.reason }) + "\\\\n")\\n            '
          return { contents: source.replace(needle, trace + needle), loader: "ts" }
        })
        build.onLoad({ filter: /sqlite\\.node/ }, async ({ path }) => {
          const source = await Bun.file(path).text()
          const needle = 'try: () => native.request({\\n            kind: "query", query, params, arrays,\\n            safeIntegers: Context.get(fiber.context, Client.SafeIntegers),\\n          }),'
          if (source.split(needle).length !== 2) throw new Error("SQLite execute seam moved; update the full-app scan-lane gate")
          const replacement = [
            'try: async () => {',
            '            const request = {',
            '              kind: "query", query, params, arrays,',
            '              safeIntegers: Context.get(fiber.context, Client.SafeIntegers),',
            '            }',
            '            const normalizedQuery = query.toLowerCase().replaceAll(String.fromCharCode(34), "")',
            '            const isUsageSummaryScan = normalizedQuery.includes("from usage_record r") || normalizedQuery.includes("from usage_record as r")',
            '            if (process.env.OPENFORK_FULL_APP_GATE_SCAN_HOLD === "1" && isUsageSummaryScan) {',
            '              const control = process.env.OPENFORK_FULL_APP_GATE_MODEL_CONTROL',
            '              if (!control) throw new Error("full-app scan hold has no model-control endpoint")',
            '              const held = await fetch(new URL("/gate/scan/wait", control))',
            '              if (!held.ok) throw new Error("full-app scan hold failed (" + held.status + ")")',
            '            }',
            '            return native.request(request)',
            '          },',
          ].join("\\n")
          return { contents: source.replace(needle, replacement), loader: "ts" }
        })
      },
    }],
  })`
    const buildSource = nodeSource
      .replace('const outFile = path.join(dir, "dist/node/node.js")', `const outFile = path.join(${JSON.stringify(absoluteNodeOut)}, "node.js")`)
      .replace('const compressWorkerFile = path.join(dir, "dist/node/compress-worker.js")', `const compressWorkerFile = path.join(${JSON.stringify(absoluteNodeOut)}, "compress-worker.js")`)
      .replace('const decompressWorkerFile = path.join(dir, "dist/node/decompress-worker.js")', `const decompressWorkerFile = path.join(${JSON.stringify(absoluteNodeOut)}, "decompress-worker.js")`)
      .replace('const stampFile = path.join(dir, "dist/node/.build-stamp")', `const stampFile = path.join(${JSON.stringify(absoluteNodeOut)}, ".build-stamp")`)
      .replace('const artifactLockFile = path.join(dir, "dist/node/.oxp-runtime-refresh.lock")', `const artifactLockFile = path.join(${JSON.stringify(absoluteNodeOut)}, ".oxp-runtime-refresh.lock")`)
      .replaceAll("./dist/node", absoluteNodeOut)
      .replace("const result = await Bun.build(options)", buildInstrumentation)
    if (buildSource === nodeSource || buildSource.includes("./dist/node") || buildSource.includes('path.join(dir, "dist/node')) throw new Error("private Node build output/instrumentation rewrite did not apply")
    await writeFile(buildScript, buildSource)
    const build = await execFileAsync("bun", [buildScript], {
      cwd: opencodeRoot,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENCODE_FORCE_NODE_BUILD: "1" },
    })
    const nodeArtifact = join(nodeOut, "node.js")
    if (!(await stat(nodeArtifact)).size) throw new Error("private Node sidecar artifact was empty")
    if (!(await readFile(nodeArtifact, "utf8")).includes("FULL_APP_GATE_INSTANCE_LOAD")) {
      throw new Error("private Node artifact omitted the InstanceStore owner trace injection")
    }
    if (!(await readFile(nodeArtifact, "utf8")).includes("OPENFORK_FULL_APP_GATE_SCAN_HOLD")) {
      throw new Error("private Node artifact omitted the SQLite scan-permit hold injection")
    }
    const afterNodeBuild = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    if (createHash("sha256").update(JSON.stringify(afterNodeBuild)).digest("hex") !== sourceFingerprint) {
      throw new Error("measured production sources changed during the private Node sidecar build")
    }
    const nodeArtifactHash = createHash("sha256").update(await readFile(nodeArtifact)).digest("hex")

    const config = `
import base from "../../electron.vite.config.ts"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
export default (env) => {
  const config = typeof base === "function" ? base(env) : base
  const override = { name: "full-app-gate-sidecar-module", enforce: "pre", resolveId(id) {
    if (id === "virtual:opencode-server") return { id: pathToFileURL(resolve(process.env.OPENFORK_FULL_APP_GATE_NODE_ARTIFACT)).href, external: true }
  } }
  config.main.plugins = [override, ...(config.main.plugins ?? []).filter((plugin) => plugin && plugin.name !== "opencode:copy-server-assets")]
  config.main.build.rollupOptions.input = { sidecar: "src/main/sidecar.ts" }
  config.preload = undefined
  config.renderer = undefined
  return config
}`
    await writeFile(configPath, config)
    await mkdir(electronOut, { recursive: true })
    await execFileAsync("bun", ["x", "electron-vite", "build", "--config", configPath, "--outDir", electronOut, "--logLevel", "warn"], {
      cwd: desktopRoot,
      timeout: 240_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, OPENFORK_FULL_APP_GATE_NODE_ARTIFACT: nodeArtifact },
    })
    const sidecarEntry = join(electronOut, "main", "sidecar.js")
    if (!(await stat(sidecarEntry)).size) throw new Error("private production sidecar build was missing")

    const vitePort = await privatePort()
    const cacheRoot = within(fixture, "vite-cache")
    if (cacheRoot.startsWith(resolve(desktopRoot)) === false) throw new Error("renderer cache is outside the fixture tree")
    const plannedProfilePaths = [
      join(dataRoot, "user-data"), join(dataRoot, "session-data"), join(dataRoot, "logs"), join(dataRoot, "crash-dumps"),
    ]
    const sqliteBase = join(dataRoot, "data", "openfork", "file-index", `${"0".repeat(64)}.db`)
    const sqlitePaths = [sqliteBase, `${sqliteBase}-wal`, `${sqliteBase}-shm`, `${sqliteBase}-journal`]
    if (sqlitePaths.some((path) => path.length >= 240)) {
      throw new Error(`private profile leaves insufficient room for Windows SQLite sidecars: ${JSON.stringify(sqlitePaths.map((path) => path.length))}`)
    }
    if (plannedProfilePaths.some((path) => {
      const rel = relative(resolve(fixture), resolve(path))
      return !rel || rel === ".." || rel.startsWith(`..${sep}`)
    })) throw new Error("Electron profile preflight escaped the fixture-owned root")
    if (vitePort === 5173) throw new Error("private renderer port preflight failed")
    vite = await createViteServer({
      configFile: false,
      root: import.meta.dir + "/full-app-startup-gate",
      publicDir: resolve(desktopRoot, "../app/public"),
      plugins: [...appPlugins, fullAppDiagnostics],
      resolve: { alias: [{ find: "@tanstack/solid-query", replacement: resolve(import.meta.dir, "../../app/node_modules/@tanstack/solid-query") }] },
      server: { host: "127.0.0.1", port: vitePort, strictPort: true, hmr: false },
      cacheDir: cacheRoot,
      optimizeDeps: { exclude: ["shiki"], include: ["@shikijs/stream", "remend"] },
      appType: "spa",
    })
    await vite.listen()
    const viteAddress = vite.httpServer?.address()
    if (!viteAddress || typeof viteAddress === "string" || viteAddress.port !== vitePort || viteAddress.address !== "127.0.0.1") {
      throw new Error(`private renderer escaped loopback binding: ${JSON.stringify(viteAddress)}`)
    }
    const mainBuild = await Bun.build({
      entrypoints: [join(import.meta.dir, "full-app-startup-gate/main.ts"), join(import.meta.dir, "full-app-startup-gate/preload.ts")],
      target: "node", format: "cjs", packages: "external", outdir: fixture,
    })
    expect(mainBuild.success, mainBuild.logs.map((log) => log.message).join("\n")).toBe(true)
    const electronMain = join(fixture, "electron-main.cjs")
    await Bun.write(electronMain, await readFile(join(fixture, "main.js")))
    const electronPreload = join(fixture, "electron-preload.cjs")
    await Bun.write(electronPreload, await readFile(join(fixture, "preload.js")))
    await execFileAsync("node", ["--check", electronMain], { timeout: 20_000 })
    await execFileAsync("node", ["--check", electronPreload], { timeout: 20_000 })

    const electron = resolve(desktopRoot, "node_modules/electron/dist/electron.exe")
    await stat(electron)
    await stat(electronMain)
    await stat(electronPreload)
    await stat(sidecarEntry)
    if (!modelPort || modelPort === viteAddress.port) throw new Error("private model/renderer ports collided or were unavailable")
    const profileRoot = resolve(dataRoot)
    if (relative(resolve(fixture), profileRoot).startsWith(`..${sep}`)) throw new Error("Electron profile path escaped fixture before launch")
    await writeFile(join(fixture, "preflight.json"), JSON.stringify({
      fixture,
      profileRoot,
      profilePaths: plannedProfilePaths,
      maximumSQLitePathLengths: sqlitePaths.map((path) => path.length),
      renderer: viteAddress,
      modelPort,
      sidecarArtifact: nodeArtifact,
      sidecarArtifactHash: nodeArtifactHash,
      sourceFingerprint,
      logRoot: join(dataRoot, "logs"),
    }, null, 2))
    const immediatelyBeforeLaunch = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    if (createHash("sha256").update(JSON.stringify(immediatelyBeforeLaunch)).digest("hex") !== sourceFingerprint) {
      throw new Error("measured production sources changed during Electron/Vite fixture builds")
    }
    const env = {
      ...process.env,
      OPENFORK_FULL_APP_GATE_SIDECAR: sidecarEntry,
      OPENFORK_FULL_APP_GATE_VITE: `http://127.0.0.1:${viteAddress.port}/`,
      OPENFORK_FULL_APP_GATE_DATA: dataRoot,
      OPENFORK_FULL_APP_GATE_WORKSPACE: workspace,
      OPENFORK_FULL_APP_GATE_PASSWORD: password,
      OPENFORK_FULL_APP_GATE_MODEL_CONTROL: `http://127.0.0.1:${modelPort}/`,
      OPENFORK_FULL_APP_GATE_PRELOAD: electronPreload,
      OPENFORK_FULL_APP_GATE_TRACE_DIR: traceRoot,
      OPENFORK_FULL_APP_GATE_REASONING_ONLY: process.env.OPENFORK_FULL_APP_GATE_REASONING_ONLY ?? "0",
      OPENFORK_FULL_APP_GATE_STARTUP_ONLY: process.env.OPENFORK_FULL_APP_GATE_STARTUP_ONLY ?? "0",
      // The default must exercise live 1/3/6 streams and Stop. The large-history
      // branch is a separate explicit run, not an early return from that gate.
      OPENFORK_FULL_APP_GATE_LARGE_HISTORY_PARTS: process.env.OPENFORK_FULL_APP_GATE_LARGE_HISTORY_PARTS ?? "0",
      OPENFORK_FULL_APP_GATE_SCAN_HOLD: "1",
    }
    delete env.ELECTRON_RUN_AS_NODE
    // The full 320-cycle campaign includes the same 1/3/6-session,
    // six-stream cancellation, and sidecar replay-gap scenarios as the short
    // gate. Give that explicit stress run enough time to finish its semantic
    // assertions on Windows; the enclosing test still has a 12-minute hard
    // deadline, and no latency or correctness threshold is relaxed.
    const historyCycles = Number(process.env.OPENFORK_FULL_APP_GATE_HISTORY_CYCLES ?? 48)
    const electronTimeoutMs = historyCycles >= 320 ? 480_000 : 360_000
    const run = await execFileAsync(electron, ["--no-sandbox", "--disable-gpu", electronMain], {
      cwd: repoRoot, env, timeout: electronTimeoutMs, maxBuffer: 64 * 1024 * 1024,
    })
    electronOutput = `${run.stdout}\n${run.stderr}`
    const marker = run.stdout.split("\n").find((line) => line.startsWith("ELECTRON_FULL_APP_STARTUP_GATE_RESULT "))
    expect(marker, electronOutput).toBeTruthy()
    const appEvidence = JSON.parse(marker!.slice("ELECTRON_FULL_APP_STARTUP_GATE_RESULT ".length)) as Record<string, any>
    const startupOnly = env.OPENFORK_FULL_APP_GATE_STARTUP_ONLY === "1"
    if (!startupOnly) {
      const scanContention = appEvidence.usageScanContention as Record<string, any> | undefined
      expect(scanContention).toMatchObject({
        requestPath: "/usage/summary",
        scanArrivals: 1,
        scanReleased: true,
        heldBeforeSelection: true,
        heldThroughActivation: true,
        summarySettledBeforeRelease: false,
        summaryStatus: 200,
      })
      expect(scanContention?.summaryElapsedMs).toBeGreaterThanOrEqual(scanContention?.selectedRouteReadyMs)
      expect(scanContention?.selectedHistoryRequestCount).toBeGreaterThan(0)
      expect(appEvidence.selected.loadedModules).toContain("session.tsx:SessionPage")
    }
    const afterRunSources = await Promise.all(sourceFiles.map(async (path) => [path, createHash("sha256").update(await readFile(resolve(repoRoot, path))).digest("hex")] as const))
    const sourceFingerprintAfterRun = createHash("sha256").update(JSON.stringify(afterRunSources)).digest("hex")
    const ownerEvents = [...electronOutput.matchAll(/^FULL_APP_GATE_INSTANCE_LOAD (\{.*\})\s*$/gm)].map((match) => JSON.parse(match[1]!))
    const evidence = {
      runID, sourceFiles: Object.fromEntries(sources), sourceFingerprint, sourceFingerprintAfterRun, nodeArtifactHash,
      runtimes: { testNode: process.versions.node, electron: appEvidence.electron, rendererNode: appEvidence.node, chromium: appEvidence.chromium },
      ownerEvents, app: appEvidence,
    }
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
    console.log("Full application startup gate evidence:", evidencePath, {
      sourceFingerprint,
      sourceFingerprintAfterRun,
      historySeed: appEvidence.historySeed,
      historySeedTailProfile: appEvidence.historySeed?.tailTrace?.cpuProfile,
      newSessionMilestones: appEvidence.newSessionMilestones,
      reasoningStop: appEvidence.reasoningStop,
      eventGapRepair: appEvidence.eventGapRepair,
      usageScanContention: appEvidence.usageScanContention,
      scenarios: (appEvidence.scenarios ?? []).map((scenario: Record<string, any>) => ({
        count: scenario.count,
        admissionMs: scenario.admissionMs,
        selectedTailMs: scenario.selectedTailMs,
        idleConvergenceMs: scenario.idleConvergenceMs,
      })),
      rendererErrors: appEvidence.final.rendererErrors,
      consoleErrors: appEvidence.final.consoleErrors,
      longAnimationFrames: appEvidence.final.longAnimationFrames,
      maxLongAnimationFrameMs: appEvidence.final.maxLongAnimationFrameMs,
      largeParts: appEvidence.largeParts,
      largeHistory: appEvidence.largeHistory,
    })
    expect(sourceFingerprintAfterRun).toBe(sourceFingerprint)

    if (startupOnly) {
      expect(appEvidence.startupOnly).toBe(true)
      expect(appEvidence.cold.path).toBe("/")
      expect(appEvidence.cold.tabs).toBe(0)
      expect(appEvidence.cold.historyReads).toBe(0)
      expect(appEvidence.cold.partReads).toBe(0)
      expect(appEvidence.cold.rendererErrors).toEqual([])
      expect(appEvidence.cold.consoleErrors).toEqual([])
      expect(appEvidence.newSessionRoute.path).toContain("new-session")
      expect(appEvidence.newSessionRoute.tabs).toBe(1)
      expect(appEvidence.newSessionRoute.historyReads).toBe(0)
      expect(appEvidence.newSessionRoute.partReads).toBe(0)
      expect(appEvidence.newSessionRoute.requestCounts["POST /session"] ?? 0).toBe(0)
      expect(appEvidence.newSessionRoute.rendererErrors).toEqual([])
      expect(appEvidence.newSessionRoute.consoleErrors).toEqual([])
      expect(Number.isFinite(appEvidence.newSessionMilestones.composerUsableMs)).toBe(true)
      expect(Number.isFinite(appEvidence.newSessionMilestones.routeMountMs)).toBe(true)
      expect(appEvidence.newSessionMilestones.providerCatalogHeld).toBe(true)
      expect(appEvidence.newSessionMilestones.providerCatalogStillPendingBeforeRelease).toBe(true)
      expect(appEvidence.newSessionMilestones.completePageRequestedOnEntry).toBe(true)
      expect(appEvidence.newSessionMilestones.draftAuxPendingBeforeRelease).toBe(appEvidence.newSessionMilestones.draftAuxPathsHeldAtComposer.length)
      expect(appEvidence.newSessionMilestones.draftAuxPathsHeldAtComposer.every((path: string) => path === "/api/reference" || path === "/api/skill")).toBe(true)
      expect(appEvidence.newSessionMilestones.composerVisibleBeforeDraftAuxRelease).toBe(true)
      expect(appEvidence.newSessionRoute.requestCounts["GET /api/skill"] ?? 0).toBe(0)
      expect(appEvidence.newSessionRoute.loadedModules).not.toContain("session-composer-region.tsx")
      expect(appEvidence.newSessionRoute.loadedModules).not.toContain("session-composer-state.ts")
      expect(appEvidence.newSessionRoute.loadedModules).not.toContain("session-composer-region-controller.ts")
      expect(Number.isFinite(appEvidence.coldElapsedMs)).toBe(true)
      expect(appEvidence.final.rendererErrors).toEqual([])
      expect(appEvidence.final.consoleErrors).toEqual([])
      return
    }

    if (appEvidence.largeHistory) {
      const result = appEvidence.largeHistory as {
        seed: { messageID: string; parts: number; elapsedMs: number }
        detailReadyMs: number
        history: Array<{ status: number; messageCount: number; partCount: number; bytes: number; windowed: string | null }>
        historyPaths: string[]
        keyedFetch: boolean
        partReads: number
        partDetailReads: number
        timelinePartReads: string[]
        timelineRecoveryElapsedMs: number
        recoveredPartCount: number
        timelinePartContentComplete: boolean
        omittedRowVisible: boolean
        composerUsableAfterDetail: boolean
        omittedParts: number
        composerMounted: boolean
        rendererErrors: string[]
        consoleErrors: string[]
      }
      expect(result.seed.parts).toBe(Number(env.OPENFORK_FULL_APP_GATE_LARGE_HISTORY_PARTS))
      expect(result.seed.elapsedMs).toBeGreaterThan(0)
      expect(result.detailReadyMs).toBeGreaterThan(0)
      expect(result.history).toHaveLength(1)
      expect(result.history[0]).toMatchObject({ status: 200, messageCount: 1, partCount: 64 })
      expect(result.history[0]!.bytes).toBeLessThan(512 * 1024)
      expect(JSON.parse(result.history[0]!.windowed ?? "[]")).toContainEqual({
        messageID: result.seed.messageID,
        omittedParts: result.seed.parts - 64,
      })
      expect(result.keyedFetch).toBe(false)
      expect(result.historyPaths.some((path) => path.endsWith(`/message/${result.seed.messageID}`))).toBe(false)
      expect(result.partReads).toBe(0)
      expect(result.omittedParts).toBe(result.seed.parts - 64)
      expect(result.recoveredPartCount).toBe(result.seed.parts)
      expect(result.timelinePartReads.length).toBe(Math.ceil(result.seed.parts / 512))
      expect(result.timelinePartReads.every((path) => path.endsWith("/timeline-parts"))).toBe(true)
      expect(result.timelinePartReads.some((path) => path.includes("/message/"))).toBe(false)
      expect(result.timelineRecoveryElapsedMs).toBeGreaterThan(0)
      expect(result.timelineRecoveryElapsedMs).toBeLessThan(15_000)
      expect(result.timelinePartContentComplete).toBe(true)
      expect(result.omittedRowVisible).toBe(false)
      expect(result.composerMounted).toBe(true)
      expect(result.composerUsableAfterDetail).toBe(true)
      expect(result.partDetailReads).toBe(0)
      expect(result.rendererErrors).toEqual([])
      expect(result.consoleErrors).toEqual([])
      expect(appEvidence.selected.loadedModules).toContain("session.tsx:SessionPage")
      expect(appEvidence.final.rendererErrors).toEqual([])
      expect(appEvidence.final.consoleErrors).toEqual([])
      expect(ownerEvents).toHaveLength(0)
    } else if (appEvidence.largeParts) {
      expect(appEvidence.largeParts.count).toBe(Number(process.env.OPENFORK_FULL_APP_GATE_LARGE_PARTS))
      expect(appEvidence.largeParts.injectionMs).toBeGreaterThanOrEqual(0)
      expect(appEvidence.largeParts.timerDelayMs).toBeGreaterThanOrEqual(appEvidence.largeParts.injectionMs)
      expect(appEvidence.largeParts.rows).toBeGreaterThanOrEqual(appEvidence.largeParts.count)
      expect(appEvidence.largeParts.virtualRows).toBeLessThan(appEvidence.largeParts.rows)
      expect(appEvidence.largeParts.rendererErrors).toEqual([])
      expect(appEvidence.largeParts.consoleErrors).toEqual([])
      expect(appEvidence.final.rendererErrors).toEqual([])
      expect(appEvidence.final.consoleErrors).toEqual([])
      expect(ownerEvents.length).toBe(1)
    } else {

    expect(appEvidence.cold.path).toBe("/")
    expect(appEvidence.cold.tabs).toBe(0)
    expect(appEvidence.cold.historyReads).toBe(0)
    expect(appEvidence.cold.requestCounts["GET /command"] ?? 0).toBe(0)
    expect(appEvidence.cold.partReads).toBe(0)
    expect(appEvidence.cold.rendererErrors).toEqual([])
    expect(appEvidence.cold.consoleErrors).toEqual([])
    expect(appEvidence.cold.visibleAlerts).toEqual([])
    expect(appEvidence.locationFailures.every((status: number) => status >= 400)).toBe(true)
    expect(appEvidence.newSessionRoute.path).toContain("new-session")
    expect(appEvidence.newSessionRoute.tabs).toBe(1)
    expect(appEvidence.newSessionRoute.historyReads).toBe(0)
    expect(appEvidence.newSessionRoute.partReads).toBe(0)
    expect(appEvidence.newSessionRoute.requestCounts["POST /session"] ?? 0).toBe(0)
    expect(appEvidence.newSessionRoute.requestCounts["GET /command"] ?? 0).toBe(0)
    expect(appEvidence.newSessionRoute.rendererErrors).toEqual([])
    expect(appEvidence.newSessionRoute.consoleErrors).toEqual([])
    expect(appEvidence.newSessionRoute.visibleAlerts).toEqual([])
    const configReads = appEvidence.newSessionRoute.requestTimings.filter((item: { method: string; path: string }) => item.method === "GET" && item.path === "/config")
    expect(configReads.length).toBeGreaterThan(0)
    expect(configReads.every((item: { status: number; elapsedMs: number }) => item.status === 200 && Number.isFinite(item.elapsedMs))).toBe(true)
    expect(Number.isFinite(appEvidence.newSessionMilestones.composerUsableMs)).toBe(true)
    expect(Number.isFinite(appEvidence.newSessionMilestones.routeMountMs)).toBe(true)
    expect(appEvidence.newSessionMilestones.providerCatalogHeld).toBe(true)
    expect(appEvidence.newSessionMilestones.providerCatalogStillPendingBeforeRelease).toBe(true)
    expect(appEvidence.newSessionMilestones.completePageRequestedOnEntry).toBe(true)
    expect(appEvidence.visibleBeforeSelect.path).toBe("/")
    expect(appEvidence.visibleBeforeSelect.tabs).toBe(0)
    expect(appEvidence.visibleBeforeSelect.rows.some((row: string) => row.includes("full-app-first-project-row"))).toBe(true)
    expect(appEvidence.visibleBeforeSelect.historyReads).toBe(0)
    expect(appEvidence.visibleBeforeSelect.requestCounts["GET /command"] ?? 0).toBe(0)
    expect(appEvidence.selected.path).toContain(`/session/${ownerSessionID(appEvidence)}`)
    expect(appEvidence.selected.promptComposerMounted).toBe(true)
    expect(appEvidence.selected.visibleBodyText).not.toContain("Something went wrong")
    expect(appEvidence.selected.loadedModules).toContain("session.tsx:SessionPage")
    expect(appEvidence.selected.requestCounts["GET /command"] ?? 0).toBe(0)
    expect(appEvidence.selected.rendererErrors).toEqual([])
    expect(appEvidence.selected.consoleErrors).toEqual([])
    const expectedHistoryCycles = Number(process.env.OPENFORK_FULL_APP_GATE_HISTORY_CYCLES ?? 48)
    expect(appEvidence.historySeed.cycles).toBe(expectedHistoryCycles)
    if (process.env.OPENFORK_FULL_APP_GATE_PROFILE_HISTORY === "1") {
      expect(appEvidence.historySeed.tailTrace?.scenario).toBe("history-seed-tail")
      expect(appEvidence.historySeed.tailTrace?.cpuProfile?.sampleCount).toBeGreaterThan(0)
      expect(appEvidence.historySeed.tailTrace?.userTimingMarks.some((mark: { name: string }) =>
        mark.name === "full-app-gate:history-seed-tail:trace-active",
      )).toBe(true)
    }
    expect(appEvidence.historySeed.elapsedMs).toBeGreaterThan(0)
    // A contiguous append must not rescan full history. Bound actual rows
    // visited across the whole campaign; projection callback counts vary with
    // event batching and do not represent work when a pass visits no rows.
    const projectionScans = appEvidence.historySeed.trace.projectionScanRowsByPass as Record<string, number>
    expect(appEvidence.historySeed.trace.projectionScanRows).toBeLessThanOrEqual(4096)
    // Tail updates may visit only the newly built/replaced turn rows. A full
    // history index rebuild is reserved for hydration/reset/reorder, not the
    // repeated contiguous-append workload.
    expect(appEvidence.historySeed.trace.rowIndexFullRebuildRows).toBeLessThanOrEqual(16_384)
    expect(appEvidence.historySeed.trace.rowIndexTailRows).toBeLessThanOrEqual(
      appEvidence.historySeed.trace.rowsBuilt * 8 + 8192,
    )
    expect(appEvidence.historySeed.trace.rowIndexRowsVisited).toBe(
      appEvidence.historySeed.trace.rowIndexFullRebuildRows + appEvidence.historySeed.trace.rowIndexTailRows,
    )
    for (const pass of ["messages", "assistant-parents", "session-structure", "context-structure"]) {
      expect(projectionScans[pass] ?? 0).toBe(0)
    }
    expect(projectionScans["group-turns"] ?? 0).toBeLessThanOrEqual(4096)
    expect(appEvidence.eventGapRepair.sseOpensBeforeGap).toBe(1)
    expect(appEvidence.eventGapRepair.sseOpenDelta).toBe(1)
    expect(appEvidence.final.sseOpens).toBe(appEvidence.eventGapRepair.sseOpensBeforeGap + appEvidence.eventGapRepair.sseOpenDelta)
    expect(appEvidence.final.sessionRootRequests.some((request: { directory: string | null }) => request.directory === "global")).toBe(false)
    expect(Object.values(appEvidence.final.rootReadsByDirectory as Record<string, number>).length).toBe(1)
    const todoReads = Object.entries(appEvidence.final.requestCounts as Record<string, number>)
      .filter(([path]) => path.startsWith("GET /session/") && path.endsWith("/todo"))
    expect(todoReads.every(([, count]) => count <= 1)).toBe(true)
    // Two bounded startup reads may use Windows vs URL path separators; a
    // single explicit row-created update may add one more. Stream fanout must
    // not request roots again in any 1/3/6 cycle.
    const finalRootReadCount = Object.values(appEvidence.final.rootReadsByDirectory as Record<string, number>)[0]
    expect(appEvidence.eventGapRepair.rootReadDelta).toBe(1)
    expect(appEvidence.eventGapRepair.sessionRootReadDelta).toBe(1)
    expect(finalRootReadCount - appEvidence.eventGapRepair.rootReadDelta).toBeLessThanOrEqual(3)
    expect(finalRootReadCount).toBeLessThanOrEqual(4)
    expect(appEvidence.final.sessionRootReads).toBe(
      appEvidence.selected.sessionRootReads + appEvidence.eventGapRepair.sessionRootReadDelta,
    )
    expect(appEvidence.scenarios.map((scenario: { count: number }) => scenario.count)).toEqual(
      process.env.OPENFORK_FULL_APP_GATE_REASONING_ONLY === "1" ? [] : [1, 3, 6],
    )
    expect(appEvidence.scenarios.every((scenario: { count: number; trace: { eventCount: number; userTimingMarks: Array<{ name: string }>; slowRendererEvents: unknown[]; path: string } }) => {
      const name = scenario.count === 6 ? "stream-6-user-scroll-up" : `stream-${scenario.count}`
      return scenario.trace.eventCount > 0 &&
        scenario.trace.userTimingMarks.some((mark) => mark.name === `full-app-gate:${name}:trace-active`) &&
        scenario.trace.slowRendererEvents.length > 0 &&
        scenario.trace.path.endsWith(`${name}.trace.json`)
    })).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { count: number; view: { timelineRenderer: { timelineRows: unknown[]; virtualRowKeys: unknown[] } } }) =>
      scenario.count !== 6 || (
        scenario.view.timelineRenderer.timelineRows.length >= 90 &&
        scenario.view.timelineRenderer.virtualRowKeys.length < scenario.view.timelineRenderer.timelineRows.length
      ),
    )).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { statuses: number[] }) => scenario.statuses.every((status) => status === 204))).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { count: number; ids: string[]; modelObserved: string[] }) =>
      scenario.modelObserved.length === scenario.count && scenario.ids.every((id) => scenario.modelObserved.includes(`${id}:${scenario.count}`)),
    )).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { view: { sessionRootReads: number } }) =>
      scenario.view.sessionRootReads === appEvidence.selected.sessionRootReads,
    )).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { view: { tabs: number; historyPaths: string[]; rendererErrors: string[]; consoleErrors: string[]; visibleAlerts: string[]; visibleBodyText: string }; uniqueTail: string; idle: Record<string, { type?: string }> }) =>
      scenario.view.tabs <= 1 &&
      scenario.view.visibleBodyText.includes(scenario.uniqueTail) &&
      scenario.view.historyPaths.every((path) => path.includes(ownerSessionID(appEvidence))) &&
      scenario.view.rendererErrors.length === 0 &&
      scenario.view.consoleErrors.length === 0 &&
      scenario.view.visibleAlerts.length === 0 &&
      Object.values(scenario.idle).every((status) => status.type !== "busy") &&
      appEvidence.scenarios.filter((candidate: { uniqueTail: string }) => candidate.uniqueTail === scenario.uniqueTail).length === 1,
    )).toBe(true)
    expect(appEvidence.reasoningStop.sessionIDs).toHaveLength(6)
    expect(appEvidence.reasoningStop.visibleChunk).toBe(0)
    expect(appEvidence.reasoningStop.visibleChunkLagMs).toBeGreaterThanOrEqual(0)
    expect(appEvidence.reasoningStop.visibleChunkLagMs).toBeLessThanOrEqual(750)
    expect(appEvidence.reasoningStop.backgroundLiveAtStop).toBe(5)
    expect(appEvidence.reasoningStop.runningToolOutput.chars).toBeGreaterThan(64 * 1024)
    expect(appEvidence.reasoningStop.runningToolOutput.completeWhileRunning).toBe(true)
    expect(appEvidence.reasoningStop.runningToolOutput.historyReadDelta).toBe(0)
    expect(appEvidence.reasoningStop.stopHandlerLagMs).toBeGreaterThanOrEqual(0)
    expect(appEvidence.reasoningStop.stopHandlerLagMs).toBeLessThanOrEqual(750)
    expect(appEvidence.reasoningStop.clickToInterruptAckMs).toBeGreaterThanOrEqual(0)
    expect(appEvidence.reasoningStop.clickToInterruptAckMs).toBeLessThanOrEqual(1_500)
    expect(appEvidence.reasoningStop.interruptAck).toMatchObject({ status: 200, body: true })
    expect(appEvidence.reasoningStop.selectedProviderClosedMs).toBeLessThanOrEqual(1_500)
    expect(appEvidence.reasoningStop.final.rendererErrors).toEqual([])
    expect(appEvidence.reasoningStop.final.consoleErrors).toEqual([])
    const commandWork = appEvidence.reasoningStop.reactiveWork.totals as Record<string, number>
    expect(commandWork.commandEligibilityChecks).toBeGreaterThan(0)
    expect(commandWork.commandSemanticUserFilterCalls ?? 0).toBe(0)
    expect(commandWork.commandSemanticUserFilterVisits ?? 0).toBe(0)
    expect(commandWork.commandSemanticUserPredicateChecks ?? 0).toBe(0)
    expect(appEvidence.eventGapRepair.gapFrames).toBeGreaterThanOrEqual(1)
    expect(appEvidence.eventGapRepair.sessionIdleBeforeStreamRelease).toBe(true)
    expect(Number.isFinite(appEvidence.eventGapRepair.completionWaitMs)).toBe(true)
    expect(appEvidence.eventGapRepair.activeSessionIDs).toContain(ownerSessionID(appEvidence))
    expect(appEvidence.eventGapRepair.historyReads).toBeGreaterThanOrEqual(1)
    expect(appEvidence.eventGapRepair.promptVisible).toBe(true)
    expect(appEvidence.eventGapRepair.assistantTailVisible).toBe(true)
    expect(appEvidence.eventGapRepair.route).toContain(`/session/${ownerSessionID(appEvidence)}`)
    expect(appEvidence.eventGapRepair.healthRecovered).toBe(true)
    expect(appEvidence.eventGapRepair.plannedOutageHealthFailures.length).toBeLessThanOrEqual(2)
    expect(appEvidence.eventGapRepair.plannedOutageHealthFailures.every((failure: { method: string; path: string; at: number }) =>
      failure.method === "GET" && ["/api/health", "/global/health"].includes(failure.path) &&
      failure.at >= appEvidence.eventGapRepair.restartStartedAt &&
      failure.at <= appEvidence.eventGapRepair.restartCompletedAt,
    )).toBe(true)
    expect(appEvidence.eventGapRepair.plannedOutageHealthFailures.filter((failure: { path: string }) => failure.path === "/api/health").length).toBeLessThanOrEqual(1)
    expect(appEvidence.eventGapRepair.plannedOutageHealthFailures.filter((failure: { path: string }) => failure.path === "/global/health").length).toBeLessThanOrEqual(1)
    expect(appEvidence.eventGapRepair.criticalRestartFailures).toEqual([])
    expect(appEvidence.eventGapRepair.backgroundRestartFailures.every((failure: { method: string; path: string; at: number }) =>
      failure.method === "GET" && ["/experimental/openrouter-free-usage", "/instance/identity"].includes(failure.path) &&
      failure.at >= appEvidence.eventGapRepair.restartStartedAt &&
      failure.at <= appEvidence.eventGapRepair.restartCompletedAt,
    )).toBe(true)
    expect(appEvidence.eventGapRepair.backgroundRestartFailures.filter((failure: { path: string }) => failure.path === "/experimental/openrouter-free-usage").length).toBeLessThanOrEqual(1)
    expect(appEvidence.eventGapRepair.backgroundRestartFailures.filter((failure: { path: string }) => failure.path === "/instance/identity").length).toBeLessThanOrEqual(1)
    expect(appEvidence.eventGapRepair.backgroundRestartFailures.length).toBeLessThanOrEqual(2)
    expect(appEvidence.eventGapRepair.restartWindowConsoleErrors).toEqual([])
    const directoryOwnedRoutes = new Set([
      "/agent", "/config", "/project/current", "/path", "/vcs", "/permission", "/question", "/session/status",
      "/provider", "/api/reference", "/api/skill", "/api/mcp", "/api/mcp/resource",
    ])
    const missingRouteLocations = appEvidence.final.observedRequests.filter((request: {
      path: string
      directory: string | null
      locationDirectory: string | null
      directoryHeader: string | null
    }) => {
      if (!directoryOwnedRoutes.has(request.path)) return false
      const location = request.directory ?? request.locationDirectory ?? request.directoryHeader
      return !location || !(location.startsWith("/") || /^[A-Za-z]:[\\/]/.test(location) || /^\\\\/.test(location))
    })
    const globalDirectoryRequests = appEvidence.final.observedRequests.filter((request: {
      path: string
      directory: string | null
      locationDirectory: string | null
    }) => directoryOwnedRoutes.has(request.path) && (request.directory === "global" || request.locationDirectory === "global"))
    expect(globalDirectoryRequests).toEqual([])
    expect(missingRouteLocations).toEqual([])
    expect(appEvidence.final.globalChildCreations).toEqual([])
    expect(appEvidence.final.requestFailures.filter((failure: { method: string; path: string; at: number }) =>
      !(failure.method === "GET" && failure.path === "/experimental/openrouter-free-usage" &&
        failure.at >= appEvidence.eventGapRepair.restartStartedAt &&
        failure.at <= appEvidence.eventGapRepair.restartCompletedAt),
    )).toEqual(appEvidence.eventGapRepair.plannedOutageHealthFailures)
    expect(Number.isFinite(appEvidence.final.maxLongAnimationFrameMs)).toBe(true)
    expect(appEvidence.final.rendererErrors).toEqual(
      appEvidence.eventGapRepair.plannedOutageHealthFailures.map((failure: { method: string; path: string; error: string }) =>
        `fetch failed ${failure.method} ${failure.path}: ${failure.error}`,
      ),
    )
    expect(appEvidence.final.consoleErrors).toEqual([])
    expect(appEvidence.final.visibleAlerts).toEqual([])
    expect(appEvidence.final.heldOptionalCount).toBe(appEvidence.final.heldOptionalPaths.length)
    expect(appEvidence.final.heldOptionalPaths.every((path: string) =>
      path === "/provider" || path === "/fork/credential" || path === "/fork/usage" || path === "/api/reference" || path === "/api/skill",
    )).toBe(true)
    // Draft auxiliary context must not be an eager prerequisite for the editor.
    // Depending on the startup interleaving, reference context may already be
    // requested or may not be demanded yet. Either way, the editor must be
    // visible before any held auxiliary work is released.
    expect(appEvidence.newSessionMilestones.draftAuxPendingBeforeRelease).toBe(
      appEvidence.newSessionMilestones.draftAuxPathsHeldAtComposer.length,
    )
    expect(appEvidence.newSessionMilestones.draftAuxPathsHeldAtComposer.every((path: string) =>
      path === "/api/reference" || path === "/api/skill",
    )).toBe(true)
    expect(appEvidence.newSessionMilestones.composerVisibleBeforeDraftAuxRelease).toBe(true)
    expect(appEvidence.newSessionRoute.requestCounts["GET /api/skill"] ?? 0).toBe(0)
    expect(appEvidence.newSessionRoute.loadedModules).not.toContain("session-composer-region.tsx")
    expect(appEvidence.newSessionRoute.loadedModules).not.toContain("session-composer-state.ts")
    expect(appEvidence.newSessionRoute.loadedModules).not.toContain("session-composer-region-controller.ts")
    expect(Number.isFinite(appEvidence.coldElapsedMs)).toBe(true)
    if (process.env.OPENFORK_FULL_APP_GATE_PROFILE_STARTUP === "1") {
      expect(appEvidence.startupTraceStart).toHaveLength(1)
      expect(["started", "timed-out", "failed"]).toContain(appEvidence.startupTraceStart[0].status)
      if (appEvidence.startupTraceStart[0].status === "started") {
        expect(appEvidence.startupTrace.preNavigation).toBe(true)
        expect(appEvidence.startupTrace.trace.eventCount).toBeGreaterThan(0)
        expect(appEvidence.startupTrace.trace.userTimingMarks.some((mark: { name: string }) => mark.name === "full-app-gate:startup-profile-clock")).toBe(true)
        expect(appEvidence.startupTrace.moduleEvaluation.length).toBeGreaterThan(0)
        expect(appEvidence.startupTrace.moduleEvaluation.every((item: { durationMs: number }) => Number.isFinite(item.durationMs))).toBe(true)
      }
      if (appEvidence.startupTrace.profile.available) {
        expect(appEvidence.startupTrace.profile.sampleCount).toBeGreaterThan(0)
        expect(appEvidence.startupTrace.profile.steps).toHaveLength(3)
      } else {
        expect(appEvidence.startupTrace.profile.steps.length).toBeGreaterThan(0)
      }
    }
    expect(Number.isFinite(appEvidence.rowVisibilityMs)).toBe(true)
    expect(appEvidence.scenarios.every((scenario: { admissionMs: number; releaseWaitMs: number; selectedTailMs: number; idleConvergenceMs: number }) =>
      [scenario.admissionMs, scenario.releaseWaitMs, scenario.selectedTailMs, scenario.idleConvergenceMs].every(Number.isFinite),
    )).toBe(true)
    expect(Number.isFinite(appEvidence.final.maxFrameGapMs)).toBe(true)
    expect(ownerEvents.every((event: { explicitLocation: boolean }) => event.explicitLocation)).toBe(true)
    expect(ownerEvents.every((event: { directory: string }) => event.directory === workspace)).toBe(true)
    const instancePIDs = new Set(ownerEvents.map((event: { pid: number }) => event.pid))
    expect(instancePIDs.size).toBe(2)
    expect([...instancePIDs].every((pid) => ownerEvents.filter((event: { pid: number }) => event.pid === pid).length === 1)).toBe(true)
    expect(ownerEvents.every((event: { caller: string; route?: string }) => event.caller === "http" && routeIsPrompt(event.route))).toBe(true)
    const profilePaths = appEvidence.profilePaths as Record<string, string>
    expect(Object.values(profilePaths).every((path) => {
      const rel = relative(resolve(dataRoot), resolve(path))
      return !!rel && rel !== ".." && !rel.startsWith(`..${sep}`)
    })).toBe(true)
    }
  } catch (error) {
    electronOutput = `${electronOutput}\n${String(error)}`
    const failure = error as { stdout?: string; stderr?: string }
    await writeFile(within(fixture, "failure.log"), `${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${electronOutput}`).catch(() => undefined)
    throw error
  } finally {
    await vite?.close()
    await model.close()
    // The cloned recipe is the only temporary file in the shared source tree;
    // it is uniquely named and owned by this exact run. Keep all fixture output
    // for diagnosis and never prune another run's artifacts.
    await rm(buildScript, { force: true }).catch(() => undefined)
    console.info("Full application gate fixture retained at", fixture)
  }
}, 720_000)

function routeIsPrompt(route: string | undefined) {
  return typeof route === "string" && /\/prompt_async$/.test(route)
}

function ownerSessionID(appEvidence: Record<string, any>) {
  return appEvidence.scenarios?.[0]?.ids?.[0] ?? appEvidence.selected?.historyPaths?.[0]?.match(/ses_[A-Za-z0-9_-]+/)?.[0] ?? "__no_session__"
}
