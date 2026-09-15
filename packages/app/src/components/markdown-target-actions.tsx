import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { createStore } from "solid-js/store"
import { Portal } from "solid-js/web"
import { makeEventListener } from "@solid-primitives/event-listener"
import { AppIcon } from "@opencode-ai/ui/app-icon"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { showToast } from "@/utils/toast"
import {
  detectOpenAppOS,
  openAppFileManager,
  openAppsForOS,
  type OpenApp,
} from "@/components/session/open-in-app"
import { firstExistingPath, resolveMarkdownCandidates } from "./markdown-path-resolve"
import { parseMarkdownTarget, type MarkdownTarget, type MarkdownTargetKind } from "./markdown-target"

/** Markdown decoration already tags these; see `markInlineCode` in session-ui. */
const TARGET_SELECTOR = "code[data-inline-code-kind]"
const SELF_SELECTOR = '[data-component="markdown-target-actions"]'
const CLOSE_DELAY_MS = 140
const COPIED_RESET_MS = 1400
const RESOLVED_PATH_CACHE_MS = 1500

function ActionButton(props: { label: string; onClick: () => void; children: JSX.Element; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      class="flex size-[22px] shrink-0 items-center justify-center rounded-[5px] transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
      classList={{
        "text-v2-state-fg-success": props.active,
        "text-v2-icon-icon-muted": !props.active,
      }}
      // Keep the span's hover state from collapsing the toolbar out from under the click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/**
 * Floating affordance for file paths and URLs written in message markdown.
 *
 * Markdown renders to plain DOM and re-renders while streaming, so rather than
 * injecting buttons into the text (which would reflow it on every token) this
 * mounts once, delegates hover from the document, and anchors a single toolbar
 * to whichever tagged span the pointer is over.
 */
export function MarkdownTargetActions() {
  const platform = usePlatform()
  const server = useServer()
  const language = useLanguage()

  const [anchor, setAnchor] = createSignal<HTMLElement>()
  const [rect, setRect] = createSignal<DOMRect>()
  const [target, setTarget] = createSignal<MarkdownTarget>()
  const [copied, setCopied] = createSignal(false)
  // While the overflow menu is open the pointer is nowhere near the span, so
  // hover-out must not tear the toolbar down underneath it.
  const [menuOpen, setMenuOpen] = createSignal(false)

  let closeTimer: ReturnType<typeof setTimeout> | undefined
  let copiedTimer: ReturnType<typeof setTimeout> | undefined
  let locateGeneration = 0
  let locating: { value: string; promise: Promise<string | undefined> } | undefined
  let resolved: { value: string; path: string; at: number } | undefined

  const resetLocation = () => {
    locateGeneration++
    locating = undefined
    resolved = undefined
  }

  const cancelClose = () => {
    if (!closeTimer) return
    clearTimeout(closeTimer)
    closeTimer = undefined
  }

  const close = () => {
    cancelClose()
    resetLocation()
    setAnchor(undefined)
    setRect(undefined)
    setTarget(undefined)
    setCopied(false)
  }

  const scheduleClose = () => {
    if (closeTimer || menuOpen()) return
    closeTimer = setTimeout(() => {
      closeTimer = undefined
      if (menuOpen()) return
      close()
    }, CLOSE_DELAY_MS)
  }

  onCleanup(() => {
    cancelClose()
    if (copiedTimer) clearTimeout(copiedTimer)
  })

  const os = createMemo(() => detectOpenAppOS(platform))
  const fileManager = createMemo(() => openAppFileManager(os()))
  // A path in the transcript belongs to the machine running the server. When
  // that is somewhere else, opening it locally would hit an unrelated file.
  const canUseFilesystem = createMemo(
    () => platform.platform === "desktop" && !!platform.openPath && server.isLocal(),
  )

  const [installed, setInstalled] = createStore<Partial<Record<OpenApp, boolean>>>({})
  createEffect(() => {
    if (!canUseFilesystem() || !platform.checkAppExists) return
    const list = openAppsForOS(os())
    void Promise.all(
      list.map((app) =>
        Promise.resolve(platform.checkAppExists?.(app.openWith))
          .then((value) => Boolean(value))
          .catch(() => false)
          .then((ok) => [app.id, ok] as const),
      ),
    ).then((entries) => setInstalled(Object.fromEntries(entries) as Partial<Record<OpenApp, boolean>>))
  })

  const editors = createMemo(() =>
    openAppsForOS(os())
      .filter((app) => installed[app.id])
      .map((app) => ({ ...app, label: language.t(app.label) })),
  )

  const fail = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("common.requestFailed"),
      description: error instanceof Error ? error.message : String(error),
    })

  const copy = () => {
    const current = target()
    if (!current) return
    const clipboard = navigator?.clipboard
    if (!clipboard) return
    void clipboard
      .writeText(current.raw)
      .then(() => {
        setCopied(true)
        if (copiedTimer) clearTimeout(copiedTimer)
        copiedTimer = setTimeout(() => setCopied(false), COPIED_RESET_MS)
      })
      .catch(fail)
  }

  /**
   * Prose names files relatively (`patch_dist.mjs`), so the written text is
   * matched against the project's file index and then probed on disk: the
   * best-ranked guess is not always the right one, and a stale index entry
   * should fall through to the next candidate instead of dead-ending.
   */
  const locate = async (current: MarkdownTarget) => {
    const now = performance.now()
    if (resolved?.value === current.value && now - resolved.at <= RESOLVED_PATH_CACHE_MS) return resolved.path
    if (locating?.value === current.value) return locating.promise

    const generation = locateGeneration
    const promise = (async () => {
      const candidates = await resolveMarkdownCandidates(current.value)
      if (candidates.length === 0) {
        showToast({ title: language.t("markdown.target.missing"), description: current.value })
        return undefined
      }
      const found = await firstExistingPath(candidates, platform.pathExists, platform.resolveExistingPath)
      if (found) {
        if (generation === locateGeneration) resolved = { value: current.value, path: found, at: performance.now() }
        return found
      }
      showToast({ title: language.t("markdown.target.missing"), description: candidates[0] })
      return undefined
    })().finally(() => {
      if (locating?.promise === promise) locating = undefined
    })
    locating = { value: current.value, promise }
    return promise
  }

  const reveal = () => {
    const current = target()
    if (!current || !platform.revealPath) return
    void locate(current)
      .then(async (path) => {
        if (!path) return
        const found = await platform.revealPath!(path)
        if (found) return
        showToast({ title: language.t("markdown.target.missing"), description: path })
      })
      .catch(fail)
  }

  const openWith = (app?: string) => {
    const current = target()
    if (!current || !platform.openPath) return
    void locate(current)
      .then((path) => (path ? platform.openPath!(path, app) : undefined))
      .catch(fail)
  }

  const openUrl = () => {
    const current = target()
    if (!current) return
    platform.openExternal(current.value)
  }

  const refreshTarget = (element: HTMLElement) => {
    const kind = element.dataset.inlineCodeKind as MarkdownTargetKind | undefined
    if (kind !== "path" && kind !== "url") return false
    const parsed = parseMarkdownTarget(kind, element.textContent ?? "")
    if (!parsed) return false
    const current = target()
    if (current?.kind === parsed.kind && current.raw === parsed.raw && current.value === parsed.value) return true
    resetLocation()
    setTarget(parsed)
    setCopied(false)
    return true
  }

  const activate = (element: HTMLElement) => {
    if (!refreshTarget(element)) return
    if (element === anchor()) return
    setAnchor(element)
    setRect(element.getBoundingClientRect())
  }

  makeEventListener(document, "pointerover", (event: PointerEvent) => {
    // Mid drag: the user is selecting text, not reaching for a button.
    if (event.buttons !== 0) return
    const node = event.target
    if (!(node instanceof Element)) return
    if (node.closest(SELF_SELECTOR)) {
      cancelClose()
      return
    }
    const code = node.closest(TARGET_SELECTOR)
    if (!(code instanceof HTMLElement)) {
      scheduleClose()
      return
    }
    cancelClose()
    activate(code)
  })

  makeEventListener(document, "keydown", (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !anchor()) return
    close()
  })

  // Streaming markdown replaces nodes, and the transcript scrolls, so the
  // anchor has to be re-measured rather than trusted once.
  createEffect(() => {
    const element = anchor()
    if (!element) return
    const sync = () => {
      if (!element.isConnected) {
        close()
        return
      }
      if (!refreshTarget(element)) {
        close()
        return
      }
      const next = element.getBoundingClientRect()
      if (next.bottom < 0 || next.top > window.innerHeight) {
        close()
        return
      }
      setRect(next)
    }
    sync()
    makeEventListener(window, "scroll", sync, { capture: true, passive: true })
    makeEventListener(window, "resize", sync)

    // A completed markdown block can still be morphed while the pointer stays
    // stationary (cache replacement, route/session updates, re-decoration).
    // Observe only the active span's parent so a stale toolbar can never act on
    // text that has already changed underneath it. MutationObserver batches the
    // callback per microtask, keeping this off the normal timeline hot path.
    const observer = new MutationObserver(sync)
    observer.observe(element.parentElement ?? element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-inline-code-kind"],
    })
    onCleanup(() => observer.disconnect())
  })

  const position = createMemo((): JSX.CSSProperties | undefined => {
    const box = rect()
    if (!box) return undefined
    const left = Math.max(8, Math.min(box.left, window.innerWidth - 168))
    // Sit above the span so the text being read is never covered; drop below
    // only when there is no room up top.
    const above = box.top > 44
    return {
      left: `${Math.round(left)}px`,
      top: `${Math.round(above ? box.top - 6 : box.bottom + 6)}px`,
      transform: above ? "translateY(-100%)" : undefined,
    }
  })

  const isPath = () => target()?.kind === "path"

  return (
    <Show when={target() && position()}>
      <Portal>
        <div
          data-component="markdown-target-actions"
          data-kind={target()?.kind}
          class="fixed z-[95] flex items-center gap-0.5 rounded-[7px] border border-v2-border-border-muted bg-v2-background-bg-layer-01 p-0.5 shadow-[var(--v2-elevation-floating)]"
          style={position()}
          onPointerEnter={cancelClose}
          onPointerLeave={scheduleClose}
        >
          <ActionButton
            label={language.t(isPath() ? "markdown.target.copyPath" : "markdown.target.copyUrl")}
            active={copied()}
            onClick={copy}
          >
            <Icon name={copied() ? "check" : "outline-copy"} size="small" class="size-3.5" />
          </ActionButton>

          <Show when={!isPath()}>
            <ActionButton label={language.t("markdown.target.openBrowser")} onClick={openUrl}>
              <Icon name="globe" size="small" class="size-3.5" />
            </ActionButton>
          </Show>

          <Show when={isPath() && canUseFilesystem()}>
            <ActionButton label={language.t(fileManager().label)} onClick={reveal}>
              <AppIcon id={fileManager().icon} class="size-3.5" alt="" />
            </ActionButton>
            <ActionButton label={language.t("markdown.target.open")} onClick={() => openWith(undefined)}>
              <Icon name="outline-square-arrow" size="small" class="size-3.5" />
            </ActionButton>

            <Show when={editors().length > 0}>
              <MenuV2 open={menuOpen()} onOpenChange={setMenuOpen} placement="bottom-end" gutter={6}>
                <MenuV2.Trigger
                  as="button"
                  type="button"
                  aria-label={language.t("markdown.target.openWith")}
                  title={language.t("markdown.target.openWith")}
                  class="flex size-[22px] shrink-0 items-center justify-center rounded-[5px] text-v2-icon-icon-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
                  onMouseDown={(event: MouseEvent) => event.preventDefault()}
                >
                  <Icon name="outline-dots" size="small" class="size-3.5" />
                </MenuV2.Trigger>
                <MenuV2.Portal>
                  <MenuV2.Content>
                    <MenuV2.Group>
                      <MenuV2.GroupLabel>{language.t("markdown.target.openWith")}</MenuV2.GroupLabel>
                      <For each={editors()}>
                        {(app) => (
                          <MenuV2.Item
                            onSelect={() => {
                              openWith(app.openWith)
                              close()
                            }}
                          >
                            <AppIcon id={app.icon} class="size-3.5 shrink-0" alt="" />
                            <span class="min-w-0 truncate">{app.label}</span>
                          </MenuV2.Item>
                        )}
                      </For>
                    </MenuV2.Group>
                  </MenuV2.Content>
                </MenuV2.Portal>
              </MenuV2>
            </Show>
          </Show>
        </div>
      </Portal>
    </Show>
  )
}
