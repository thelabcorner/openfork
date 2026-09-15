import { createSignal, lazy, Show, Suspense } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import type { useCommand } from "@/context/command"
import type { usePlatform } from "@/context/platform"

const WindowsAppMenuRuntime = lazy(() =>
  import("./windows-app-menu-runtime").then((module) => ({ default: module.WindowsAppMenuRuntime })),
)

export function WindowsAppMenu(props: {
  command: ReturnType<typeof useCommand>
  platform: ReturnType<typeof usePlatform>
  variant?: "legacy" | "v2"
}) {
  const language = useLanguage()
  const [requested, setRequested] = createSignal(false)
  const [open, setOpen] = createSignal(false)
  let trigger: HTMLButtonElement | undefined
  let lastFocused: HTMLElement | undefined

  const rememberFocus = () => {
    const active = document.activeElement
    lastFocused = active instanceof HTMLElement ? active : undefined
  }

  const prepare = () => {
    rememberFocus()
    setRequested(true)
  }

  const show = () => {
    setRequested(true)
    setOpen(true)
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown") return
    event.preventDefault()
    prepare()
    show()
  }

  const button =
    props.variant === "v2" ? (
      <div data-component="desktop-icon-button" class="flex h-7 w-9 shrink-0 items-center justify-center rounded-[6px] px-1">
        <IconButtonV2
          ref={trigger}
          type="button"
          variant="ghost-muted"
          size="large"
          icon={<IconV2 name="menu" />}
          aria-label={language.t("desktop.menu.ariaLabel")}
          aria-haspopup="menu"
          aria-expanded={open()}
          onPointerDown={prepare}
          onKeyDown={onKeyDown}
          onClick={show}
        />
      </div>
    ) : (
      <IconButton
        ref={trigger}
        type="button"
        icon="menu"
        variant="ghost"
        class="titlebar-icon rounded-md shrink-0"
        aria-label={language.t("desktop.menu.ariaLabel")}
        aria-haspopup="menu"
        aria-expanded={open()}
        onPointerDown={prepare}
        onKeyDown={onKeyDown}
        onClick={show}
      />
    )

  return (
    <>
      {button}
      <Show when={requested()}>
        <Suspense>
          <WindowsAppMenuRuntime
            command={props.command}
            platform={props.platform}
            open={open()}
            anchor={() => trigger}
            lastFocused={() => lastFocused}
            onOpenChange={(next) => {
              setOpen(next)
              if (next) return
              queueMicrotask(() => trigger?.focus({ preventScroll: true }))
            }}
          />
        </Suspense>
      </Show>
    </>
  )
}
