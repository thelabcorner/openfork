import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useQueryClient } from "@tanstack/solid-query"
import { useLocation } from "@solidjs/router"
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { pendingWork } from "@/utils/pending-work"

function queryLabel(query: { queryKey: readonly unknown[] }) {
  return query.queryKey
    .map((part) => {
      if (part === null || part === undefined) return "null"
      if (typeof part === "string" || typeof part === "number" || typeof part === "boolean") return String(part)
      return JSON.stringify(part)
    })
    .join(" · ")
}

export function RouteLoadingFallback() {
  const language = useLanguage()
  const location = useLocation()
  const queryClient = useQueryClient()
  const started = Date.now()
  const [now, setNow] = createSignal(started)
  const [copied, setCopied] = createSignal(false)
  const [tick, setTick] = createSignal(0)
  const [seenQueries, setSeenQueries] = createStore({ items: [] as { key: string; started: number; done: boolean }[] })

  onMount(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 250)
    const unsub = queryClient.getQueryCache().subscribe(() => setTick((value) => value + 1))
    onCleanup(() => {
      window.clearInterval(clock)
      unsub()
    })
  })

  const seconds = () => Math.max(0, Math.floor((now() - started) / 1000))
  const queries = createMemo(() => {
    tick()
    return queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.fetchStatus === "fetching" || query.state.status === "pending")
  })
  const waits = createMemo(() => pendingWork())
  const waitMs = (item: { started: number; done: boolean }) => (item.done ? 0 : now() - item.started)

  createEffect(() => {
    const active = new Set(queries().map(queryLabel))
    for (const key of active) {
      if (seenQueries.items.some((item) => item.key === key)) continue
      setSeenQueries("items", (items) => [...items, { key, started: Date.now(), done: false }])
    }
    for (const item of seenQueries.items) {
      const done = !active.has(item.key)
      if (item.done !== done) setSeenQueries("items", (row) => row.key === item.key, "done", done)
    }
  })

  const report = createMemo(() => {
    const lines = [
      `route: ${location.pathname}${location.search}`,
      `elapsedMs: ${now() - started}`,
      "queries:",
      ...(seenQueries.items.length === 0
        ? ["  (none)"]
        : seenQueries.items.map((item) => `  ${item.key} (${item.done ? 0 : now() - item.started}ms)`)),
      "pending:",
      ...(waits().length === 0
        ? ["  (none — Solid Suspense is holding this view)"]
        : waits().map((item) => `  ${item.label} (${waitMs(item)}ms)`)),
    ]
    return lines.join("\n")
  })

  const copy = () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard
    if (!clipboard?.writeText) return
    void clipboard.writeText(report()).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <div class="flex-1 min-h-0 w-full flex items-center justify-center p-6">
      <div
        role="status"
        class="w-full max-w-md rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] p-4 flex flex-col gap-3"
      >
        <div class="flex items-center gap-3">
          <Spinner class="size-5 shrink-0" style={{ color: "var(--icon-weak)" }} />
          <div class="min-w-0 flex flex-col gap-0.5">
            <div class="text-14-medium text-text-strong">{language.t("route.loading.title")}</div>
            <div class="text-12-regular text-text-faint">{language.t("route.loading.elapsed", { seconds: seconds() })}</div>
          </div>
        </div>
        <div class="text-12-regular text-text-weak">{language.t("route.loading.description")}</div>
        <div class="text-12-regular text-text-faint break-all" dir="ltr">
          {location.pathname}
          {location.search}
        </div>
        <Show
          when={seenQueries.items.length > 0}
          fallback={<div class="text-12-regular text-text-faint">{language.t("route.loading.queries.empty")}</div>}
        >
          <ul class="flex flex-col gap-1 max-h-40 overflow-auto text-12-regular text-text-weak" dir="ltr">
            <For each={seenQueries.items}>
              {(item) => (
                <li class="break-all">
                  {item.key} · {item.done ? 0 : now() - item.started}ms
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={waits().length > 0}>
          <ul class="flex flex-col gap-1 max-h-32 overflow-auto text-12-regular text-text-weak" dir="ltr">
            <For each={waits()}>
              {(item) => (
                <li class="break-all">
                  {item.label} · {waitMs(item)}ms
                </li>
              )}
            </For>
          </ul>
        </Show>
        <Show when={seenQueries.items.length === 0 && waits().length === 0}>
          <div class="text-12-regular text-text-faint">{language.t("route.loading.suspense")}</div>
        </Show>
        <div>
          <ButtonV2 variant="ghost-muted" size="normal" icon="outline-copy" onClick={copy}>
            {copied() ? language.t("route.loading.copied") : language.t("route.loading.copy")}
          </ButtonV2>
        </div>
      </div>
    </div>
  )
}
