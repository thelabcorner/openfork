import { createEffect, createSignal, lazy, Show, Suspense, type ParentProps } from "solid-js"
import { PwaTabBar } from "@/components/pwa/tab-bar"
import { PwaPushRuntime } from "@/components/pwa/push-runtime"
import { RouteLoadingFallback } from "@/components/route-loading-fallback"
import { useCommand } from "@/context/command"
import { keyboardInset } from "@/utils/keyboard-inset"
import { setV2Toast, ToastRegion } from "@/utils/toast"

const PwaSettingsSheet = lazy(() =>
  import("@/components/pwa/settings-sheet").then((module) => ({ default: module.PwaSettingsSheet })),
)

// Third layout arm (docs/pwa-mobile/03 §1.4, §7 phase 2): mobile chrome around
// the same routed children as the legacy/new arms. Sheets are not history
// entries (01 §2.4) — settings opens in a sheet over whatever route is active.
export default function MobileLayout(props: ParentProps) {
  const command = useCommand()
  const [settingsOpen, setSettingsOpen] = createSignal(false)
  const [settingsMounted, setSettingsMounted] = createSignal(false)
  const viewport = keyboardInset()
  createEffect(() => setV2Toast(true))

  return (
    <div
      class="relative flex min-h-0 min-w-0 flex-1 flex-col select-none bg-v2-background-bg-deep [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      data-keyboard-open={viewport.keyboardOpen ? "" : undefined}
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
        // The layout viewport stays full-height in installed iOS PWAs while the
        // visual viewport contracts. Reserve only the actually covered bottom
        // area so the timeline/composer remain above the keyboard.
        "padding-bottom": viewport.keyboardOpen ? `${viewport.bottomInset}px` : undefined,
      }}
    >
      <PwaPushRuntime />
      <main
        class="min-h-0 min-w-0 flex-1 overflow-x-hidden flex flex-col items-start"
        style={{ contain: "layout paint style" }}
      >
        <Suspense fallback={<RouteLoadingFallback />}>{props.children}</Suspense>
      </main>
      <Show when={!viewport.keyboardOpen}>
        <PwaTabBar
          active={settingsOpen() ? "settings" : undefined}
          onSearch={() => command.show()}
          onSettings={() => {
            setSettingsMounted(true)
            setSettingsOpen(true)
          }}
        />
      </Show>
      <Show when={settingsMounted()}>
        <Suspense>
          <PwaSettingsSheet open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
        </Suspense>
      </Show>
      <ToastRegion v2 />
    </div>
  )
}
