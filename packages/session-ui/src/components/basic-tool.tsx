import {
  createEffect,
  createMemo,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  type Accessor,
  type JSX,
} from "solid-js"
import { animate, type AnimationPlaybackControls } from "motion"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { createStore } from "solid-js/store"
import { Collapsible } from "@opencode-ai/ui/collapsible"
import { Icon, type IconProps } from "@opencode-ai/ui/icon"
import { TextShimmer } from "@opencode-ai/ui/text-shimmer"
import { SmartToolOutput } from "./tool-output"
import { ToolParams } from "./tool-parts"

export type ResultTone = "neutral" | "success" | "warning" | "danger"

export type TriggerTitle = {
  title: string
  titleClass?: string
  subtitle?: string
  subtitleClass?: string
  /** Paths read better truncated from the left; commands from the right. */
  subtitleTruncate?: "start" | "end"
  subtitleMono?: boolean
  args?: string[]
  argsClass?: string
  /**
   * What the call returned, shown right-aligned in the collapsed row so the
   * outcome is legible without expanding: "142 lines", "exit 0 · 4.2s",
   * "22 matches · 3 files".
   */
  result?: string
  resultTone?: ResultTone
  /** Diff counts, rendered in place of `result` when present. */
  changes?: { additions: number; deletions: number }
  action?: JSX.Element
}

const isTriggerTitle = (val: any): val is TriggerTitle => {
  return (
    typeof val === "object" && val !== null && "title" in val && (typeof Node === "undefined" || !(val instanceof Node))
  )
}

export interface BasicToolProps {
  icon: IconProps["name"]
  /** Replaces the badge glyph — e.g. a progress indicator while a subagent runs. */
  iconContent?: JSX.Element
  /**
   * Identity colour for the badge (subagent colours). Tints the badge only; the
   * title stays neutral so a column of rows still scans as one column.
   */
  accent?: string
  trigger: TriggerTitle | JSX.Element | ((open: Accessor<boolean>) => JSX.Element)
  children?: JSX.Element
  status?: string
  /**
   * Result slot for renderers that supply a custom `trigger` element and so
   * cannot express it via `TriggerTitle`. Takes precedence over the trigger's
   * own `result` when both are set.
   */
  result?: string
  resultTone?: ResultTone
  changes?: { additions: number; deletions: number }
  /**
   * `card` (default) frames one tool's output as a single panel. `tree` uses an
   * indented rail and belongs to expansions holding several items — a
   * multi-file patch, a grouped run of calls. `plain` opts out of both.
   */
  contentVariant?: "card" | "tree" | "plain"
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  forceOpen?: boolean
  allowOpenWhilePending?: boolean
  defer?: boolean
  locked?: boolean
  animated?: boolean
  onSubtitleClick?: () => void
  onTriggerClick?: JSX.EventHandlerUnion<HTMLElement, MouseEvent>
  onTriggerKeyDown?: JSX.EventHandlerUnion<HTMLElement, KeyboardEvent>
  triggerHref?: string
  triggerAsLink?: boolean
  clickable?: boolean
}

const SPRING = { type: "spring" as const, visualDuration: 0.35, bounce: 0 }
const deferredMounts: Array<{ active: boolean; fn: () => void }> = []
let deferredFrame: number | undefined

function flushDeferredMounts() {
  while (deferredMounts.length > 0) {
    // Timeline tools are mounted top-to-bottom, but the viewport starts at the latest turn.
    // Pop from the end so heavy default-open bodies near the bottom become interactive first.
    const item = deferredMounts.pop()!
    if (item.active) {
      deferredFrame = deferredMounts.length > 0 ? requestAnimationFrame(flushDeferredMounts) : undefined
      item.fn()
      return
    }
  }
  deferredFrame = undefined
}

function scheduleDeferredFlush() {
  if (deferredFrame !== undefined) return
  deferredFrame = requestAnimationFrame(() => {
    deferredFrame = requestAnimationFrame(flushDeferredMounts)
  })
}

function scheduleDeferredMount(fn: () => void) {
  const item = { active: true, fn }
  deferredMounts.push(item)
  scheduleDeferredFlush()
  return () => {
    item.active = false
  }
}

function scheduleFrameMount(fn: () => void) {
  const frame = requestAnimationFrame(fn)
  return () => cancelAnimationFrame(frame)
}

export function BasicTool(props: BasicToolProps) {
  const [state, setState] = createStore({
    open: props.defaultOpen ?? false,
    ready: !props.defer && (props.defaultOpen ?? false),
  })
  const open = () => props.open ?? state.open
  const ready = () => state.ready
  const pending = () => props.status === "pending" || props.status === "running"
  const hasChildren = () => (props.defer ? "children" in props : props.children)
  const dynamicTrigger = typeof props.trigger === "function" ? props.trigger(open) : undefined

  let cancelReady: (() => void) | undefined

  const cancel = () => {
    cancelReady?.()
    cancelReady = undefined
  }

  const scheduleReady = (initial = false) => {
    cancel()
    cancelReady = (initial ? scheduleDeferredMount : scheduleFrameMount)(() => {
      cancelReady = undefined
      if (!open()) return
      setState("ready", true)
    })
  }

  onCleanup(cancel)

  onMount(() => {
    if (props.defer && open()) scheduleReady(true)
  })

  const setOpen = (value: boolean) => {
    if (props.open === undefined) setState("open", value)
    props.onOpenChange?.(value)
  }

  createEffect(() => {
    if (!props.forceOpen) return
    if (open()) return
    setOpen(true)
  })

  createEffect(
    on(
      open,
      (value) => {
        if (!props.defer) return
        if (!value) {
          cancel()
          setState("ready", false)
          return
        }

        scheduleReady()
      },
      { defer: true },
    ),
  )

  // Animated height for collapsible open/close
  let contentRef: HTMLDivElement | undefined
  let heightAnim: AnimationPlaybackControls | undefined
  const initialOpen = open()

  createEffect(
    on(
      open,
      (isOpen) => {
        if (!props.animated || !contentRef) return
        heightAnim?.stop()
        if (isOpen) {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "auto" }, SPRING)
          void heightAnim.finished.then(() => {
            if (!contentRef || !open()) return
            contentRef.style.overflow = "visible"
            contentRef.style.height = "auto"
          })
        } else {
          contentRef.style.overflow = "hidden"
          heightAnim = animate(contentRef, { height: "0px" }, SPRING)
        }
      },
      { defer: true },
    ),
  )

  onCleanup(() => {
    heightAnim?.stop()
  })

  const handleOpenChange = (value: boolean) => {
    if (pending() && !props.allowOpenWhilePending) return
    if (props.locked && !value) return
    setOpen(value)
  }

  const titleProps = () => (isTriggerTitle(props.trigger) ? props.trigger : undefined)

  const result = () => {
    if (pending()) return undefined
    const title = titleProps()
    const changes = props.changes ?? title?.changes
    if (changes) return { kind: "changes" as const, changes }
    const text = props.result ?? title?.result
    if (text) return { kind: "text" as const, text, tone: props.resultTone ?? title?.resultTone ?? "neutral" }
    return undefined
  }

  /**
   * A single tool's output reads as a card — one framed panel hanging off the
   * row. The indented rail is reserved for `tree`, where the expansion holds
   * *several* things (a multi-file patch, a grouped run of calls) and the
   * indent is doing real work showing containment.
   */
  const body = () => (
    <div data-slot="tool-content" data-variant={props.contentVariant ?? "card"}>
      {props.children}
    </div>
  )

  const trigger = () => (
    <div
      data-component="tool-trigger"
      data-clickable={props.clickable ? "true" : undefined}
      data-hide-details={props.hideDetails ? "true" : undefined}
      data-status={props.status}
      data-accent={props.accent ? "true" : undefined}
      style={props.accent ? { "--tool-badge-accent": props.accent } : undefined}
    >
      <div data-slot="basic-tool-tool-trigger-content">
        <Show when={props.icon || props.iconContent}>
          <span data-slot="basic-tool-tool-icon" data-status={props.status}>
            <Show when={props.iconContent} fallback={<Icon name={props.icon} size="small" style={{ "stroke-width": 1.5 }} />}>
              {props.iconContent}
            </Show>
          </span>
        </Show>
        <div data-slot="basic-tool-tool-info">
          <Switch>
            <Match when={dynamicTrigger !== undefined}>{dynamicTrigger}</Match>
            <Match when={isTriggerTitle(props.trigger) && props.trigger}>
              {(title) => (
                <div data-slot="basic-tool-tool-info-structured">
                  <div data-slot="basic-tool-tool-info-main">
                    <span
                      data-slot="basic-tool-tool-title"
                      classList={{
                        [title().titleClass ?? ""]: !!title().titleClass,
                      }}
                    >
                      <TextShimmer text={title().title} active={pending()} />
                    </span>
                    <Show when={!pending() || title().subtitle || title().args?.length}>
                      <Show when={title().subtitle}>
                        <span data-slot="basic-tool-tool-sep" aria-hidden="true">
                          ·
                        </span>
                        <span
                          data-slot="basic-tool-tool-subtitle"
                          data-truncate={title().subtitleTruncate}
                          data-mono={title().subtitleMono ? "true" : undefined}
                          classList={{
                            [title().subtitleClass ?? ""]: !!title().subtitleClass,
                            clickable: !!props.onSubtitleClick,
                          }}
                          onClick={(e) => {
                            if (props.onSubtitleClick) {
                              e.stopPropagation()
                              props.onSubtitleClick()
                            }
                          }}
                        >
                          {/* Wrapper keeps LTR order intact under the rtl left-truncation trick. */}
                          <span>{title().subtitle}</span>
                        </span>
                      </Show>
                      <Show when={title().args?.length}>
                        <For each={title().args}>
                          {(arg) => (
                            <span
                              data-slot="basic-tool-tool-arg"
                              classList={{
                                [title().argsClass ?? ""]: !!title().argsClass,
                              }}
                            >
                              {arg}
                            </span>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                  <Show when={!pending() && title().action}>
                    <span data-slot="basic-tool-tool-action">{title().action}</span>
                  </Show>
                </div>
              )}
            </Match>
            <Match when={true}>{props.trigger as JSX.Element}</Match>
          </Switch>
        </div>
      </div>
      <Show when={result()}>
        {(value) => (
          <Switch>
            <Match when={value().kind === "changes" && value()}>
              {(entry) => (
                <span data-slot="basic-tool-tool-diff">
                  <span data-slot="basic-tool-tool-diff-add">+{entry().changes!.additions}</span>
                  <span data-slot="basic-tool-tool-diff-del">&minus;{entry().changes!.deletions}</span>
                </span>
              )}
            </Match>
            <Match when={value().kind === "text" && value()}>
              {(entry) => (
                <span data-slot="basic-tool-tool-result" data-tone={entry().tone}>
                  {entry().text}
                </span>
              )}
            </Match>
          </Switch>
        )}
      </Show>
      <Show when={hasChildren() && !props.hideDetails && !props.locked && (!pending() || props.allowOpenWhilePending)}>
        <Collapsible.Arrow />
      </Show>
    </div>
  )

  return (
    <Collapsible open={open()} onOpenChange={handleOpenChange} class="tool-collapsible">
      <Show
        when={props.triggerAsLink || props.triggerHref}
        fallback={
          <Collapsible.Trigger
            data-hide-details={props.hideDetails ? "true" : undefined}
            onClick={props.onTriggerClick}
          >
            {trigger()}
          </Collapsible.Trigger>
        }
      >
        <Collapsible.Trigger
          as="a"
          href={props.triggerHref}
          role={!props.triggerHref && props.clickable ? "button" : undefined}
          tabIndex={!props.triggerHref && props.clickable ? 0 : undefined}
          data-hide-details={props.hideDetails ? "true" : undefined}
          onClick={props.onTriggerClick}
          onKeyDown={props.onTriggerKeyDown}
        >
          {trigger()}
        </Collapsible.Trigger>
      </Show>
      <Show when={props.animated && hasChildren() && !props.hideDetails}>
        <div
          ref={contentRef}
          data-slot="collapsible-content"
          data-animated
          style={{
            height: initialOpen ? "auto" : "0px",
            overflow: initialOpen ? "visible" : "hidden",
          }}
        >
          <Show when={!props.defer || ready()}>{body()}</Show>
        </div>
      </Show>
      <Show when={!props.animated && hasChildren() && !props.hideDetails}>
        <Collapsible.Content>
          <Show when={!props.defer || ready()}>{body()}</Show>
        </Collapsible.Content>
      </Show>
    </Collapsible>
  )
}

function label(input: Record<string, unknown> | undefined) {
  const keys = ["description", "query", "url", "filePath", "path", "pattern", "name"]
  return keys.map((key) => input?.[key]).find((value): value is string => typeof value === "string" && value.length > 0)
}

function args(input: Record<string, unknown> | undefined, extraSkip: string[] = []) {
  if (!input) return []
  const skip = new Set(["description", "query", "url", "filePath", "path", "pattern", "name", ...extraSkip])
  return Object.entries(input)
    .filter(([key]) => !skip.has(key))
    .flatMap(([key, value]) => {
      if (typeof value === "string") return [`${key}=${value}`]
      if (typeof value === "number") return [`${key}=${value}`]
      if (typeof value === "boolean") return [`${key}=${value}`]
      return []
    })
    .slice(0, 3)
}

/**
 * Floor for tools without a bespoke renderer.
 *
 * This used to print the raw input as a syntax-highlighted JSON block above a
 * markdown dump of the output, which is how `browser_status`, `memory`,
 * `session` and every MCP tool ended up unreadable. Params are now a dense chip
 * strip and the output stands on its own.
 */
export function GenericTool(props: {
  tool: string
  status?: string
  hideDetails?: boolean
  input?: Record<string, unknown>
  output?: string
  icon?: IconProps["name"]
  title?: string
  subtitle?: string
  result?: string
  resultTone?: ResultTone
  argsSkip?: string[]
}) {
  const i18n = useI18n()

  return (
    <BasicTool
      icon={props.icon ?? "brain"}
      status={props.status}
      trigger={{
        title: props.title ?? i18n.t("ui.basicTool.called", { tool: props.tool }),
        subtitle: props.subtitle ?? label(props.input),
        args: args(props.input, props.argsSkip),
        result: props.result,
        resultTone: props.resultTone,
      }}
      hideDetails={props.hideDetails}
    >
      <ToolParams input={props.input} skip={props.argsSkip} />
      <Show when={props.output}>
        <SmartToolOutput output={props.output} />
      </Show>
    </BasicTool>
  )
}
