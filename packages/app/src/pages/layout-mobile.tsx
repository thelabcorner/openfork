import { createSignal, Suspense, type ParentProps } from "solid-js"
import { PwaSettingsSheet } from "@/components/pwa/settings-sheet"
import { PwaTabBar } from "@/components/pwa/tab-bar"
import { RouteLoadingFallback } from "@/components/route-loading-fallback"
import { useCommand } from "@/context/command"
import { ToastRegion } from "@/utils/toast"

// Third layout arm (docs/pwa-mobile/03 §1.4, §7 phase 2): mobile chrome around
// the same routed children as the legacy/new arms. Sheets are not history
// entries (01 §2.4) — settings opens in a sheet over whatever route is active.
export default function MobileLayout(props: ParentProps) {
  const command = useCommand()
  const [settingsOpen, setSettingsOpen] = createSignal(false)

  return (
    <div
      class="relative flex min-h-0 min-w-0 flex-1 flex-col select-none bg-v2-background-bg-deep [&_input]:select-text [&_textarea]:select-text [&_[contenteditable]]:select-text"
      style={{
        "padding-top": "env(safe-area-inset-top, 0px)",
      }}
    >
      <main class="min-h-0 min-w-0 flex-1 overflow-x-hidden flex flex-col items-start contain-strict">
        <Suspense fallback={<RouteLoadingFallback />}>{props.children}</Suspense>
      </main>
      <PwaTabBar onSearch={() => command.show()} onSettings={() => setSettingsOpen(true)} />
      <PwaSettingsSheet open={settingsOpen()} onClose={() => setSettingsOpen(false)} />
      <ToastRegion v2 />
    </div>
  )
}
