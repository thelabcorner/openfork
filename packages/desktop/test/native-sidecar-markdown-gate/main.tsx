import { createSignal, onCleanup, onMount } from "solid-js"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { Markdown } from "../../../session-ui/src/components/markdown"
import { createServerSdkContext } from "../../../app/src/context/server-sdk"
import { createServerSyncContextInner } from "../../../app/src/context/server-sync"
import { PlatformProvider, type Platform } from "../../../app/src/context/platform"
import { LanguageProvider } from "../../../app/src/context/language"
import { ServerScope } from "../../../app/src/utils/server-scope"
import { dict } from "../../../app/src/i18n/en"
import type { ServerConnection } from "../../../app/src/context/server"
import { createDesktopFetch } from "../../src/renderer/control-fetch"
import type { SidecarControlFetchInput } from "../../../app/src/utils/sidecar-control-request"

declare global {
  interface Window {
    __nativeSidecarMarkdownGate?: { run: () => Promise<Record<string, unknown>> }
    __nativeGateTrace?: Array<{ phase?: string; priority?: string; status?: string }>
    __opencodeServerStreamQoS?: () => Record<string, { advertisedSessions?: number; remoteInterestReady?: boolean; framesRead?: number }>
    __nativeGateControl?: {
      dispatch: (requestID: string, input: SidecarControlFetchInput) => Promise<{
        status: number
        statusText: string
        headers: Record<string, string>
        body?: string
      }>
      cancel: (requestID: string) => void
    }
  }
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const within = <T,>(promise: Promise<T>, ms: number, message: string) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ])
const query = new URLSearchParams(location.search)
const baseURL = query.get("server")!
const directory = query.get("directory")!
const password = query.get("password")!
const modelControlURL = query.get("modelControl")!
const sessionIDs = JSON.parse(query.get("sessions") ?? "[]") as string[]
const auth = `Basic ${btoa(`opencode:${password}`)}`
const originalFetch = globalThis.fetch.bind(globalThis)
const sidecarOrigin = new URL(baseURL).origin
let sseOpens = 0
const observeSseOpen = (request: Request) => {
  const url = new URL(request.url)
  if (
    request.method === "GET" &&
    url.origin === sidecarOrigin &&
    (url.pathname === "/global/event" || url.pathname === "/api/event")
  ) sseOpens++
}
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init)
  observeSseOpen(request)
  return originalFetch(request)
}) as typeof globalThis.fetch
const authenticatedFetch: typeof globalThis.fetch = async (input, init) => {
  const request = new Request(input, init)
  const url = new URL(request.url)
  if (url.origin !== sidecarOrigin) return originalFetch(request)
  observeSseOpen(request)
  const headers = new Headers(request.headers)
  headers.set("authorization", auth)
  return originalFetch(new Request(request, { headers }))
}
const desktopFetch = createDesktopFetch({
  fetch: authenticatedFetch,
  awaitInitialization: async () => ({ url: baseURL, username: "opencode", password }),
  dispatch: (requestID, input) => {
    if (!window.__nativeGateControl) throw new Error("native gate desktop control bridge is unavailable")
    return window.__nativeGateControl.dispatch(requestID, input)
  },
  cancel: (requestID) => window.__nativeGateControl?.cancel(requestID),
})
const platform = {
  platform: "desktop",
  os: "windows",
  fetch: desktopFetch,
} as unknown as Platform
const connection = { type: "http", http: { url: baseURL, username: "opencode", password } } as ServerConnection.Any
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
let lastFrame = performance.now()
let maxFrameGapMs = 0
const sampleFrame = () => {
  const now = performance.now()
  maxFrameGapMs = Math.max(maxFrameGapMs, now - lastFrame)
  lastFrame = now
  requestAnimationFrame(sampleFrame)
}
requestAnimationFrame(sampleFrame)
const textFor = (session: ReturnType<typeof createServerSyncContextInner>["session"], id: string) => {
  const message = session.data.session_message[id]?.at(-1)
  const part = message ? session.data.part[message.id]?.find((value) => value.type === "text") : undefined
  return part && part.type === "text" ? part.text : ""
}
const promptAsync = (id: string, text: string) =>
  platform.fetch(`${baseURL}session/${encodeURIComponent(id)}/prompt_async?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "native-gate", modelID: "gate-model" },
      parts: [{ type: "text", text }],
    }),
  })
const promptSync = (id: string, text: string) =>
  platform.fetch(`${baseURL}session/${encodeURIComponent(id)}/message?directory=${encodeURIComponent(directory)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: { providerID: "native-gate", modelID: "gate-model" },
      parts: [{ type: "text", text }],
    }),
  })
const streamSnapshot = () => Object.values(window.__opencodeServerStreamQoS?.() ?? {})[0]

function Host() {
  const sdk = createServerSdkContext(connection, ServerScope.local)
  const sync = createServerSyncContextInner(sdk)
  const session = sync.session
  onCleanup(() => sessionIDs.forEach((id) => session.release(id)))
  onMount(() => {
    window.__nativeGateTrace = []
    window.__opencodeMarkdownTraceEnabled = () => true
    window.__opencodeMarkdownTrace = (event: { phase?: string; priority?: string; status?: string }) =>
      window.__nativeGateTrace!.push(event)
    window.__nativeSidecarMarkdownGate = {
      async run() {
        const root = document.querySelector<HTMLElement>("#root")!
        const scenarios: Array<Record<string, unknown>> = []
        const backgroundID = sessionIDs[6]!
        console.info("[native-gate] background prompt start")
        const backgroundResponse = await within(
          promptSync(backgroundID, `native-gate-background-${backgroundID}`),
          60_000,
          "native gate background prompt did not settle",
        )
        if (!backgroundResponse.ok) throw new Error(`background fixture prompt failed (${backgroundResponse.status})`)
        console.info("[native-gate] background prompt settled")
        await within(
          session.sync(backgroundID, { force: true, activate: false }),
          30_000,
          "native gate background session sync did not settle",
        )
        console.info("[native-gate] background sync settled")
        const backgroundElement = document.createElement("section")
        backgroundElement.style.cssText = "position:fixed;top:0;left:0;width:2px;height:2px;overflow:hidden;opacity:0"
        document.body.append(backgroundElement)
        let backgroundDispose = render(
          () => <Markdown text={textFor(session, backgroundID)} cacheKey="native-background-heavy" streaming={false} />,
          backgroundElement,
        )
        for (const concurrency of [1, 3, 6]) {
          root.replaceChildren()
          window.__nativeGateTrace = []
          backgroundDispose()
          backgroundElement.replaceChildren()
          backgroundDispose = render(
            () => <Markdown text={textFor(session, backgroundID)} cacheKey={`native-background-heavy-${concurrency}`} streaming={false} />,
            backgroundElement,
          )
          await frame()
          const active = sessionIDs.slice(0, concurrency)
          await Promise.all(active.map((id) => session.sync(id, { force: true, activate: true })))
          const interestDeadline = performance.now() + 10_000
          let interestAcked = false
          while (performance.now() < interestDeadline && !interestAcked) {
            const qos = streamSnapshot()
            interestAcked = qos?.remoteInterestReady === true && qos.advertisedSessions === active.length
            await frame()
          }
          const dispose = active.map((id) => {
            const element = document.createElement("section")
            element.style.cssText = `height:${Math.floor(700 / concurrency)}px;overflow:hidden;padding:8px`
            root.append(element)
            return render(
              () => <Markdown text={textFor(session, id)} cacheKey={`native-gate-${id}`} streaming={session.data.session_working(id)} />,
              element,
            )
          })
          await frame()
          const promptResponses = Promise.all(active.map((id) => promptAsync(id, `native-gate-${id}`)))
          const urgentProbeStartedAt = performance.now()
          const urgentProbe = await within(
            platform.fetch(`${baseURL}global/event/interest`, {
              method: "POST",
              headers: { authorization: auth, "content-type": "application/json" },
              body: JSON.stringify({
                subscriber: `native-gate-probe-${concurrency}`,
                generation: 0,
                sessions: active,
              }),
            }),
            5_000,
            `native gate urgent control request starved behind admission traffic (concurrency=${concurrency})`,
          )
          const urgentProbeMs = performance.now() - urgentProbeStartedAt
          if (!urgentProbe.ok) throw new Error(`native gate urgent control request failed (${urgentProbe.status})`)
          const admissionDeadline = performance.now() + 30_000
          while (performance.now() < admissionDeadline && active.some((id) => !root.textContent?.includes(`native-start-${id}`))) await frame()
          const startsSeen = active.filter((id) => root.textContent?.includes(`native-start-${id}`)).length
          const releaseStartedAt = performance.now()
          const released = await platform.fetch(`${modelControlURL}gate/release`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessions: active }),
          })
          if (!released.ok) throw new Error(`fixture model stream release failed (${released.status})`)
          const releaseResult = await released.json() as { released?: string[]; missing?: string[] }
          if ((releaseResult.missing?.length ?? 0) > 0) {
            throw new Error(
              `native gate admission deadline expired before model start: ${JSON.stringify({
                concurrency,
                startsSeen,
                missing: releaseResult.missing,
              })}`,
            )
          }
          const tailDeadline = performance.now() + 30_000
          while (performance.now() < tailDeadline && active.some((id) => !root.textContent?.includes(`native-tail-${id}`))) await frame()
          await frame()
          const promptStatuses = (
            await within(
              promptResponses,
              30_000,
              `native gate prompt responses did not settle after release (concurrency=${concurrency})`,
            )
          ).map((response) => response.status)
          const rendered = active.filter((id) => root.textContent?.includes(`native-tail-${id}`)).length
          const traces = window.__nativeGateTrace ?? []
          const tailSuccesses = traces.filter((event) => event.phase === "worker" && event.status === "ok" && event.priority === "tail").length
          scenarios.push({
            concurrency,
            rendered,
            storeConverged: active.every((id) => textFor(session, id).includes(`native-tail-${id}`)),
            promptStatuses,
            urgentProbeStatus: urgentProbe.status,
            urgentProbeMs,
            interestAcked,
            startsSeen,
            tailFirstProgressMs: performance.now() - releaseStartedAt,
            tailSuccesses,
            backgroundParseMs: traces.filter((event) => event.phase === "worker" && event.kind === "parse" && event.priority === "background").map((event) => event.ms),
            queueSuccesses: traces.filter((event) => event.phase === "worker" && event.status === "ok").length,
            roots: root.querySelectorAll(".markdown").length,
          })
          dispose.forEach((drop) => drop())
          active.forEach((id) => session.release(id))
        }
        root.replaceChildren()
        backgroundDispose()
        backgroundElement.remove()
        await frame()
        return {
          completed: scenarios.every((scenario) => scenario.rendered === scenario.concurrency),
          rendered: scenarios.at(-1)?.rendered,
          scenarios,
          sseOpens,
          streamFramesRead: streamSnapshot()?.framesRead ?? 0,
          maxFrameGapMs,
          teardownRoots: root.querySelectorAll(".markdown").length,
        }
      },
    }
  })
  return <div style={{ display: "contents" }} />
}

render(
  () => (
    <PlatformProvider value={platform}>
      <LanguageProvider dictionary={dict}>
        <QueryClientProvider client={queryClient}><Host /></QueryClientProvider>
      </LanguageProvider>
    </PlatformProvider>
  ),
  document.querySelector("#root")!,
)
