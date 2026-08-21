import { Component, For, Match, Show, Switch, createEffect, createMemo, createSignal, type JSX } from "solid-js"
import { createVirtualizer } from "@tanstack/solid-virtual"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { KeybindV2 } from "@opencode-ai/ui/v2/keybind-v2"
import { getDirectory, getFilename } from "@opencode-ai/core/util/path"
import { buildAtRows, groupTitleKey, splitHighlightSegments, type AtGroup, type AtRow } from "./at-rows"

export type AtSymbolKind = "fn" | "method" | "class" | "interface" | "type" | "enum" | "const" | (string & {})

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | {
      type: "resource"
      name: string
      uri: string
      client: string
      display: string
      description?: string
      mime?: string
    }
  | { type: "reference"; name: string; path: string; display: string; description: string }
  | { type: "file"; path: string; display: string; recent?: boolean; isDir?: boolean; positions?: number[] }
  | {
      type: "symbol"
      name: string
      path: string
      line: number
      symbolKind: AtSymbolKind
      display: string
      positions?: number[]
    }
  | {
      type: "external"
      name: string
      path: string
      base: string
      isDir: boolean
      status: "ok" | "pending" | "denied"
      display: string
    }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

const ROW_HEIGHT = 28
const LOAD_MORE_THRESHOLD = 12

const primaryTextClass = (v2: boolean) => ({
  "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]": v2,
  "text-v2-text-text-base": v2,
  "text-14-regular": !v2,
  "text-text-strong": !v2,
})

const mutedTextClass = (v2: boolean) => ({
  "text-v2-text-text-muted": v2,
  "text-text-weak": !v2,
})

function HighlightedText(props: { text: string; positions?: number[] }) {
  const segments = createMemo(() => splitHighlightSegments(props.text, props.positions))
  return (
    <Show when={segments()} fallback={<>{props.text}</>}>
      {(parts) => (
        <For each={parts()}>
          {(segment) => <span classList={{ "font-semibold": segment.hit }}>{segment.text}</span>}
        </For>
      )}
    </Show>
  )
}

function AtHeaderRow(props: { title: string }) {
  return (
    <div class="flex h-full select-none items-center px-2 pt-1 text-11-medium uppercase tracking-[0.06em] text-text-subtle">
      {props.title}
    </div>
  )
}

function AtShimmerRows(props: { rows: number }) {
  return (
    <div class="flex flex-col gap-1.5 px-2 py-1.5">
      <For each={Array.from({ length: props.rows }, (_, index) => index)}>
        {(index) => (
          <div
            class="h-[18px] rounded bg-surface-raised-base-hover animate-pulse"
            style={{ width: `${72 - index * 14}%`, "animation-delay": `${index * 120}ms` }}
          />
        )}
      </For>
    </div>
  )
}

function AtEmptyState(props: { searching: boolean; t: (key: string) => string }) {
  return (
    <Show when={!props.searching} fallback={<AtShimmerRows rows={3} />}>
      <div class="px-2 py-1">
        <div class="text-text-weak">{props.t("prompt.popover.emptyResults")}</div>
        <div class="text-12-regular text-text-subtle">{props.t("prompt.popover.emptyResultsHint")}</div>
      </div>
    </Show>
  )
}

function AtAgentContent(props: { option: Extract<AtOption, { type: "agent" }>; v2: boolean }) {
  return (
    <>
      <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
      <span class="whitespace-nowrap" classList={primaryTextClass(props.v2)}>
        @{props.option.name}
      </span>
    </>
  )
}

function AtResourceContent(props: { option: Extract<AtOption, { type: "resource" }>; v2: boolean }) {
  return (
    <>
      <FileIcon node={{ path: props.option.uri, type: "file" }} class="shrink-0 size-4" />
      <div class="flex items-center min-w-0">
        <span class="text-text-strong whitespace-nowrap" classList={primaryTextClass(props.v2)}>
          @{props.option.name}
        </span>
        <Show when={props.option.description}>
          {(description) => (
            <span class="whitespace-nowrap truncate min-w-0 ml-2" classList={mutedTextClass(props.v2)}>
              {description()}
            </span>
          )}
        </Show>
      </div>
    </>
  )
}

function AtReferenceContent(props: { option: Extract<AtOption, { type: "reference" }>; v2: boolean }) {
  return (
    <>
      <FileIcon node={{ path: props.option.path, type: "directory" }} class="shrink-0 size-4" />
      <div class="flex items-center min-w-0">
        <span class="text-text-strong whitespace-nowrap" classList={primaryTextClass(props.v2)}>
          @{props.option.name}
        </span>
        <span class="whitespace-nowrap truncate min-w-0 ml-2" classList={mutedTextClass(props.v2)}>
          {props.option.description}
        </span>
      </div>
    </>
  )
}

function AtPathContent(props: { option: Extract<AtOption, { type: "file" }>; v2: boolean }) {
  const isDirectory = () => !!props.option.isDir || props.option.path.endsWith("/")
  const directory = () => getDirectory(props.option.path)
  const filename = () => getFilename(props.option.path)
  return (
    <>
      <Show
        when={isDirectory()}
        fallback={<FileIcon node={{ path: props.option.path, type: "file" }} class="shrink-0 size-4" />}
      >
        <FileIcon node={{ path: props.option.path, type: "directory" }} class="shrink-0 size-4" />
      </Show>
      <div class="flex items-center min-w-0">
        <Show when={!isDirectory() && directory()}>
          {(value) => (
            <span class="whitespace-nowrap truncate min-w-0 shrink" classList={mutedTextClass(props.v2)}>
              {value()}
            </span>
          )}
        </Show>
        <span class="whitespace-nowrap truncate min-w-0 text-text-strong">
          <HighlightedText text={filename()} positions={props.option.positions} />
        </span>
      </div>
    </>
  )
}

function AtSymbolContent(props: { option: Extract<AtOption, { type: "symbol" }>; v2: boolean }) {
  return (
    <>
      <span class="shrink-0 w-16 text-center rounded bg-surface-base px-1 py-px text-10-regular text-text-subtle">
        {props.option.symbolKind}
      </span>
      <span class="whitespace-nowrap shrink-0 text-text-strong" classList={primaryTextClass(props.v2)}>
        <HighlightedText text={props.option.name} positions={props.option.positions} />
      </span>
      <span class="whitespace-nowrap truncate min-w-0 ml-auto pl-3" classList={mutedTextClass(props.v2)}>
        {props.option.path}:{props.option.line}
      </span>
    </>
  )
}

function AtExternalContent(props: {
  option: Extract<AtOption, { type: "external" }>
  v2: boolean
  statusLabel?: string
}) {
  const showBase = () => props.option.base && props.option.base !== props.option.name
  return (
    <>
      <Show
        when={props.option.isDir}
        fallback={<FileIcon node={{ path: props.option.name, type: "file" }} class="shrink-0 size-4" />}
      >
        <FileIcon node={{ path: props.option.name, type: "directory" }} class="shrink-0 size-4" />
      </Show>
      <div class="flex items-center min-w-0">
        <Show when={showBase()}>
          {(value) => (
            <span class="whitespace-nowrap truncate min-w-0 shrink" classList={mutedTextClass(props.v2)}>
              {value()}
            </span>
          )}
        </Show>
        <span class="whitespace-nowrap truncate min-w-0 text-text-strong">{props.option.name}</span>
      </div>
      <Show when={props.statusLabel}>
        {(label) => (
          <span class="shrink-0 ml-auto pl-3 rounded bg-surface-base px-1 py-px text-10-regular text-text-subtle">
            {label()}
          </span>
        )}
      </Show>
    </>
  )
}

function AtItemContent(props: { option: AtOption; v2: boolean; statusLabel?: string }): JSX.Element {
  const option = props.option
  if (option.type === "agent") return <AtAgentContent option={option} v2={props.v2} />
  if (option.type === "resource") return <AtResourceContent option={option} v2={props.v2} />
  if (option.type === "reference") return <AtReferenceContent option={option} v2={props.v2} />
  if (option.type === "symbol") return <AtSymbolContent option={option} v2={props.v2} />
  if (option.type === "external")
    return <AtExternalContent option={option} v2={props.v2} statusLabel={props.statusLabel} />
  return <AtPathContent option={option} v2={props.v2} />
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atGroups: AtGroup[]
  atSearching: boolean
  atLoadingMore: boolean
  onAtLoadMore?: () => void
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  slashMenu: boolean
  slashMenuQuery: string
  onSlashMenuInput: (value: string) => void
  onSlashMenuKeyDown: (event: KeyboardEvent) => void
  commandKeybind: (id: string) => string | undefined
  commandKeybindParts: (id: string) => string[]
  newLayoutDesigns: boolean
  t: (key: string) => string
}

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  const [atScrollRoot, setAtScrollRoot] = createSignal<HTMLDivElement>()

  const atRows = createMemo(() => buildAtRows(props.atGroups))

  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return atRows().length
    },
    getScrollElement: () => atScrollRoot() ?? null,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    getItemKey: (index) => {
      const row = atRows()[index]
      if (!row) return String(index)
      return row.kind === "header" ? `header:${row.category}` : props.atKey(row.option)
    },
  })

  createEffect(() => {
    const id = props.atActive
    if (!id) return
    const index = atRows().findIndex((row) => row.kind === "item" && props.atKey(row.option) === id)
    if (index < 0) return
    queueMicrotask(() => virtualizer.scrollToIndex(index, { align: "auto" }))
  })

  createEffect(() => {
    const items = virtualizer.getVirtualItems()
    const last = items[items.length - 1]
    if (!last) return
    if (last.index >= atRows().length - LOAD_MORE_THRESHOLD) props.onAtLoadMore?.()
  })

  const overlayHeader = createMemo(() => {
    const all = atRows()
    const first = virtualizer.getVirtualItems()[0]
    if (!first) return undefined
    let headerIndex = -1
    for (let i = first.index; i >= 0; i--) {
      if (all[i]?.kind === "header") {
        headerIndex = i
        break
      }
    }
    if (headerIndex < 0 || headerIndex === first.index) return undefined
    const row = all[headerIndex]
    return row?.kind === "header" ? props.t(groupTitleKey(row.category)) : undefined
  })

  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left min-h-10 flex flex-col p-2"
        classList={{
          "z-[70] rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]": props.newLayoutDesigns,
          "rounded-[12px] bg-surface-raised-stronger-non-alpha shadow-[var(--shadow-lg-border-base)]":
            !props.newLayoutDesigns,
          "max-h-80 overflow-auto no-scrollbar": props.popover === "slash",
          "overflow-visible": props.popover === "at",
        }}
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show when={props.atFlat.length > 0} fallback={<AtEmptyState searching={props.atSearching} t={props.t} />}>
              <div class="relative">
                <div ref={setAtScrollRoot} class="max-h-[320px] overflow-y-auto no-scrollbar">
                  <div style={{ position: "relative", height: `${virtualizer.getTotalSize()}px` }}>
                    <For each={virtualizer.getVirtualItems()}>
                      {(virtualRow) => {
                        const row = atRows()[virtualRow.index]
                        if (!row) return null
                        if (row.kind === "header") {
                          return <AtHeaderRow title={props.t(groupTitleKey(row.category))} />
                        }
                        const option = row.option
                        const key = props.atKey(option)
                        const statusLabel =
                          option.type === "external" && option.status !== "ok"
                            ? props.t(
                                option.status === "pending"
                                  ? "prompt.popover.externalPending"
                                  : "prompt.popover.externalDenied",
                              )
                            : undefined
                        return (
                          <button
                            class="w-full flex h-full items-center gap-x-2 px-2 rounded-md"
                            classList={{
                              "bg-v2-overlay-simple-overlay-hover":
                                props.newLayoutDesigns && props.atActive === key,
                              "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.atActive === key,
                            }}
                            onClick={() => props.onAtSelect(option)}
                            onPointerMove={() => props.setAtActive(key)}
                          >
                            <AtItemContent option={option} v2={props.newLayoutDesigns} statusLabel={statusLabel} />
                          </button>
                        )
                      }}
                    </For>
                  </div>
                  <Show when={props.atSearching || props.atLoadingMore}>
                    <AtShimmerRows rows={props.atFlat.length > 0 ? 1 : 3} />
                  </Show>
                </div>
                <Show when={overlayHeader()}>
                  {(title) => (
                    <div
                      class="pointer-events-none absolute inset-x-0 top-0 z-10 flex h-[28px] items-center bg-surface-raised-stronger-non-alpha px-2 pt-1 text-11-medium uppercase tracking-[0.06em] text-text-subtle"
                      classList={{ "bg-v2-background-bg-base": props.newLayoutDesigns }}
                    >
                      {title()}
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show when={props.slashMenu}>
              <div class="px-2 py-1">
                <input
                  ref={(el) => requestAnimationFrame(() => el.focus())}
                  value={props.slashMenuQuery}
                  onInput={(event) => props.onSlashMenuInput(event.currentTarget.value)}
                  onKeyDown={props.onSlashMenuKeyDown}
                  onMouseDown={(event) => event.stopPropagation()}
                  aria-label={props.t("prompt.menu.commands")}
                  placeholder="/"
                  class="w-full bg-transparent outline-none text-[13px] leading-5 text-v2-text-text-base placeholder:text-v2-text-text-faint"
                />
              </div>
            </Show>
            <Show
              when={props.slashFlat.length > 0}
              fallback={
                <div
                  class="px-2 py-1"
                  classList={{
                    "text-v2-text-text-muted": props.newLayoutDesigns,
                    "text-text-weak": !props.newLayoutDesigns,
                  }}
                >
                  {props.t("prompt.popover.emptyCommands")}
                </div>
              }
            >
              <For each={props.slashFlat}>
                {(cmd) => {
                  const keybind = () => props.commandKeybind(cmd.id)
                  const keybindParts = () => props.commandKeybindParts(cmd.id)
                  return (
                    <button
                      data-slash-id={cmd.id}
                      classList={{
                        "w-full flex items-center justify-between gap-4 px-2 py-1": true,
                        "rounded-[4px] scroll-my-2": props.newLayoutDesigns,
                        "rounded-md": !props.newLayoutDesigns,
                        "bg-v2-overlay-simple-overlay-hover": props.newLayoutDesigns && props.slashActive === cmd.id,
                        "bg-surface-raised-base-hover": !props.newLayoutDesigns && props.slashActive === cmd.id,
                      }}
                      onClick={() => props.onSlashSelect(cmd)}
                      onPointerMove={() => props.setSlashActive(cmd.id)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span
                          class="whitespace-nowrap"
                          classList={{
                            "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                              props.newLayoutDesigns,
                            "text-v2-text-text-base": props.newLayoutDesigns,
                            "text-14-regular": !props.newLayoutDesigns,
                            "text-text-strong": !props.newLayoutDesigns,
                          }}
                        >
                          /{cmd.trigger}
                        </span>
                        <Show when={cmd.description}>
                          <span
                            class="truncate"
                            classList={{
                              "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]":
                                props.newLayoutDesigns,
                              "text-v2-text-text-muted": props.newLayoutDesigns,
                              "text-14-regular": !props.newLayoutDesigns,
                              "text-text-weak": !props.newLayoutDesigns,
                            }}
                          >
                            {cmd.description}
                          </span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                          <Show
                            when={props.newLayoutDesigns}
                            fallback={
                              <span class="text-11-regular px-1.5 py-0.5 rounded bg-surface-base text-text-subtle">
                                {cmd.source === "skill"
                                  ? props.t("prompt.slash.badge.skill")
                                  : cmd.source === "mcp"
                                    ? props.t("prompt.slash.badge.mcp")
                                    : props.t("prompt.slash.badge.custom")}
                              </span>
                            }
                          >
                            <Tag>
                              {cmd.source === "skill"
                                ? props.t("prompt.slash.badge.skill")
                                : cmd.source === "mcp"
                                  ? props.t("prompt.slash.badge.mcp")
                                  : props.t("prompt.slash.badge.custom")}
                            </Tag>
                          </Show>
                        </Show>
                        <Show when={props.newLayoutDesigns ? keybindParts().length > 0 : keybind()}>
                          <Show
                            when={props.newLayoutDesigns}
                            fallback={<span class="text-12-regular text-text-subtle">{keybind()}</span>}
                          >
                            <KeybindV2 keys={keybindParts()} variant="neutral" />
                          </Show>
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
