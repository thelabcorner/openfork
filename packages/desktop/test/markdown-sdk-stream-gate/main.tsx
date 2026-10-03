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

declare global {
  interface Window {
    __sdkMarkdownGate?: { run: () => Promise<Record<string, unknown>> }
    __markdownTraceEvents?: Array<{ phase?: string; priority?: string; status?: string }>
    __opencodeServerStreamQoS?: () => Record<string, { advertisedSessions?: number; remoteInterestReady?: boolean; framesRead?: number }>
  }
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const backendProxy = import.meta.env.VITE_SDK_MARKDOWN_USE_BACKEND_PROXY === "true"
const peerURL = backendProxy
  ? (import.meta.env.VITE_SDK_MARKDOWN_API_URL as string)
  : (import.meta.env.VITE_SDK_MARKDOWN_PEER_URL as string)
const controlURL = (import.meta.env.VITE_SDK_MARKDOWN_CONTROL_URL as string | undefined) ?? peerURL
const ids = JSON.parse(import.meta.env.VITE_SDK_MARKDOWN_SESSION_IDS ?? "[]") as string[]
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })
const platform = { platform: "desktop", os: "windows", fetch: globalThis.fetch } as unknown as Platform
const connection = { type: "http", http: { url: peerURL } } as ServerConnection.Any
const textFor = (session: ReturnType<typeof createServerSyncContextInner>["session"], id: string) => {
  const message = session.data.session_message[id]?.at(-1)
  const part = message ? session.data.part[message.id]?.find((value) => value.type === "text") : undefined
  return part && part.type === "text" ? part.text : ""
}
const streamSnapshot = () => Object.values(window.__opencodeServerStreamQoS?.() ?? {})[0]
function Host() {
  const sdk = createServerSdkContext(connection, ServerScope.local)
  const sync = createServerSyncContextInner(sdk)
  const session = sync.session
  onCleanup(() => {
    for (const id of ids) session.release(id)
  })
  onMount(() => {
    window.__opencodeMarkdownTraceEnabled = () => true
    window.__opencodeMarkdownTrace = (event: { phase?: string; priority?: string; status?: string }) =>
      window.__markdownTraceEvents!.push(event)
    window.__sdkMarkdownGate = {
      async run() {
        const root = document.querySelector<HTMLElement>("#root")!
        const scenarios: Array<Record<string, unknown>> = []
        for (const concurrency of [1, 3, 6]) {
          root.replaceChildren()
          window.__markdownTraceEvents = []
          const active = ids.slice(0, concurrency)
          await Promise.all(active.map((id) => session.sync(id, { force: true, activate: true })))
          const interestDeadline = performance.now() + 10_000
          let interestAcked = false
          while (performance.now() < interestDeadline && !interestAcked) {
            const stats = streamSnapshot()
            interestAcked = stats?.remoteInterestReady === true && stats.advertisedSessions === active.length
            await frame()
          }
          const containers = new Map<string, HTMLElement>()
          const dispose = active.map((id, index) => {
            const element = document.createElement("section")
            element.style.cssText = `height:${Math.floor(700 / concurrency)}px;overflow:hidden;padding:8px`
            root.append(element)
            containers.set(id, element)
            return render(
              () => <Markdown text={textFor(session, id)} cacheKey={`sdk-gate-${id}`} streaming={session.data.session_working(id)} />,
              element,
            )
          })
          await frame()
          await frame()
          await fetch(`${controlURL}gate/control`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "deltas", sessions: active }),
          })
          const deadline = performance.now() + 20_000
          while (performance.now() < deadline && active.some((id) => !root.textContent?.includes(`sse-tail-${id}`))) await frame()
          await frame()
          const rendered = active.filter((id) => root.textContent?.includes(`sse-tail-${id}`)).length
          const frames = window.__markdownTraceEvents ?? []
          scenarios.push({
            concurrency,
            rendered,
            storeConverged: active.every((id) => textFor(session, id).includes(`sse-tail-${id}`)),
            workerEvents: frames.filter((event) => event.phase === "worker" && event.status === "ok").length,
            interestActivated: active.every((id) => session.acceptStreamContent(id)),
            interestAcked,
            roots: root.querySelectorAll(".markdown").length,
          })
          for (const disposeRoot of dispose) disposeRoot()
          active.forEach((id) => session.release(id))
        }

        // Force the server to close the current connection; the production
        // stream reader must reconnect from its last SSE id and deliver the
        // subsequent event without any navigation or explicit store repair.
        await fetch(`${controlURL}gate/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "disconnect" }) })
        await new Promise<void>((resolve) => setTimeout(resolve, 350))
        await fetch(`${controlURL}gate/control`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cursor-marker", session: ids[0] }) })
        const cursorDeadline = performance.now() + 20_000
        while (performance.now() < cursorDeadline && !textFor(session, ids[0]!).includes(`cursor-tail-${ids[0]}`)) await frame()

        // A protocol gap must latch the active session and repair from HTTP.
        // The first authoritative repair intentionally fails; the running
        // timeline must retry and converge on its own.
        const repairID = ids[0]!
        await session.sync(repairID, { force: true, activate: true })
        await fetch(`${controlURL}gate/control`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "gap", session: repairID, failFirstRepair: true }),
        })
        const repairDeadline = performance.now() + 25_000
        while (performance.now() < repairDeadline && !textFor(session, repairID).includes(`repaired-after-gap-${repairID}`)) await frame()
        const autonomousRepair = textFor(session, repairID).includes(`repaired-after-gap-${repairID}`)
        const peerStats = controlURL === peerURL
          ? await fetch(`${controlURL}gate/stats`).then((response) => response.json()) as { streamRequests?: Array<{ cursor?: string }> }
          : undefined
        const stale = session.needsRepair(repairID)
        for (const id of ids) session.release(id)
        root.replaceChildren()
        await frame()
        return {
          completed: scenarios.every((scenario) => scenario.rendered === scenario.concurrency),
          concurrency: 6,
          rendered: scenarios.at(-1)?.rendered,
          scenarios,
          interestActivated: scenarios.every((scenario) => scenario.interestActivated),
          cursorReconnect: peerStats?.streamRequests?.some((request) => request.cursor !== undefined) ?? false,
          streamFramesRead: streamSnapshot()?.framesRead ?? 0,
          autonomousRepair,
          repairAfterFirstFailure: controlURL === peerURL ? !stale : undefined,
          teardownRoots: root.querySelectorAll(".markdown").length,
        }
      },
    }
  })
  return <div style={{ display: "contents" }} />
}

window.__markdownTraceEvents = []
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
