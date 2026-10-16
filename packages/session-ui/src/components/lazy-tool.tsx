import { createMemo, createSignal, Match, Show, Switch } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import type { IconProps } from "@opencode-ai/ui/icon"
import { BasicTool } from "./basic-tool"
import { ToolBadge, ToolBlock, ToolBoundedList, ToolEmpty, ToolNotice, ToolParams, ToolRow } from "./tool-parts"
import { SmartToolOutput } from "./tool-output"
import { getToolResult } from "./tool-result"
import {
  lazyToolCatalog,
  lazyToolDescriptor,
  lazyToolIdentity,
  lazyVisibleArgs,
  readableToolName,
} from "./lazy-tool-model"

export type LazyToolProps = {
  input: Record<string, any>
  metadata: Record<string, any>
  tool: string
  output?: string
  status?: string
  hideDetails?: boolean
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  deferContent?: boolean
  forceOpen?: boolean
  locked?: boolean
}

export function lazyToolIcon(target: string | undefined, action: string): IconProps["name"] {
  if (action === "list") return "bullet-list"
  if (action === "describe") return "glasses"
  switch (target) {
    case "swarm":
    case "task":
      return "task"
    case "usage":
      return "usage"
    case "quota":
    case "models":
      return "providers"
    case "browser":
      return "window-cursor"
    case "code":
      return "code"
    case "memory":
      return "brain"
    case "project":
      return "folder"
    case "symbols":
      return "file-tree"
    default:
      return "mcp"
  }
}

/**
 * The lazy broker is a transport boundary, not a human-facing tool identity.
 * Keep execution metadata intact but render the actual invoked capability.
 * No requests, transcript scans, per-row timers, or duplicate tool ownership.
 */
export function LazyTool(props: LazyToolProps) {
  const i18n = useI18n()
  const identity = createMemo(() => lazyToolIdentity(props.input, props.metadata))
  const catalog = createMemo(() => lazyToolCatalog(props.output))
  const descriptor = createMemo(() => lazyToolDescriptor(props.output))
  const visibleArgs = createMemo(() => lazyVisibleArgs(identity().args))
  const [showRaw, setShowRaw] = createSignal(false)
  const targetTitle = createMemo(() => identity().name ?? i18n.t("ui.tool.lazy.capability"))
  const title = createMemo(() => identity().action === "list" ? i18n.t("ui.tool.lazy.catalog") : targetTitle())
  const subtitle = createMemo(() => {
    if (identity().action === "list") return i18n.t("ui.tool.lazy.discover")
    if (identity().action === "describe") return i18n.t("ui.tool.lazy.inspect")
    return identity().operation ?? identity().subject ?? i18n.t("ui.tool.lazy.execute")
  })
  const outcome = createMemo(() => {
    if (props.status !== "completed") return undefined
    // Do not parse catalog/schema payloads merely to decorate a collapsed row.
    if (identity().action !== "call") return { text: i18n.t("ui.tool.lazy.ready") }
    const native = getToolResult({
      tool: identity().target ?? "",
      args: identity().args,
      metadata: props.metadata,
      output: props.output,
      status: props.status,
    })
    // Transport completion does not establish a successful domain outcome.
    return native ?? { text: i18n.t("ui.tool.lazy.complete"), tone: "neutral" as const }
  })
  const rawToggle = () => (
    <Show when={props.output}>
      <button
        type="button"
        data-slot="lazy-tool-raw-toggle"
        aria-expanded={showRaw()}
        onClick={() => setShowRaw((value) => !value)}
      >
        {i18n.t(showRaw() ? "ui.tool.lazy.hideRaw" : "ui.tool.lazy.showRaw")}
      </button>
      <Show when={showRaw()}>
        <div data-slot="lazy-tool-raw-output"><SmartToolOutput output={props.output} /></div>
      </Show>
    </Show>
  )

  return (
    <div data-component="lazy-tool" data-action={identity().action}>
      <BasicTool
        {...props}
        defer={props.deferContent}
        icon={lazyToolIcon(identity().target, identity().action)}
        trigger={{
          title: title(),
          subtitle: subtitle(),
          args: identity().operation && identity().subject ? [identity().subject!] : undefined,
          result: outcome()?.text,
          resultTone: outcome()?.tone,
          changes: outcome()?.changes,
        }}
      >
        <Switch>
          <Match when={identity().action === "list"}>
            <ToolBlock
              label={i18n.t("ui.tool.lazy.available")}
              trailing={catalog().length ? i18n.t("ui.tool.lazy.availableCount", { count: catalog().length }) : undefined}
            >
              <Show when={catalog().length} fallback={
                <Show when={props.output} fallback={<ToolEmpty>{i18n.t("ui.tool.lazy.waiting")}</ToolEmpty>}>
                  <SmartToolOutput output={props.output} />
                </Show>
              }>
                <ToolBoundedList items={catalog()} limit={8}>
                  {(item) => (
                    <ToolRow
                      primary={readableToolName(item.id) ?? item.id}
                      secondary={item.description}
                      mono={false}
                    />
                  )}
                </ToolBoundedList>
              </Show>
            </ToolBlock>
            <Show when={catalog().length > 0}>{rawToggle()}</Show>
          </Match>
          <Match when={identity().action === "describe"}>
            <Show when={descriptor()} fallback={
              <Show when={props.output} fallback={<ToolEmpty>{i18n.t("ui.tool.lazy.waiting")}</ToolEmpty>}>
                <SmartToolOutput output={props.output} />
              </Show>
            }>
              {(data) => (
                <>
                  <Show when={data().description}>
                    <ToolNotice message={data().description!} />
                  </Show>
                  <ToolBlock
                    label={i18n.t("ui.tool.lazy.parameters")}
                    trailing={i18n.t("ui.tool.lazy.parameterCount", { count: data().parameters.length })}
                  >
                    <Show when={data().parameters.length} fallback={<ToolEmpty>{i18n.t("ui.tool.lazy.noParameters")}</ToolEmpty>}>
                      <ToolBoundedList items={data().parameters} limit={10}>
                        {(item) => (
                          <ToolRow
                            primary={item.name}
                            secondary={item.description}
                            trailing={
                              <span data-slot="lazy-tool-parameter-meta">
                                <span>{item.type}</span>
                                <Show when={item.required}>
                                  <ToolBadge tone="neutral">{i18n.t("ui.tool.lazy.required")}</ToolBadge>
                                </Show>
                              </span>
                            }
                          />
                        )}
                      </ToolBoundedList>
                    </Show>
                  </ToolBlock>
                </>
              )}
            </Show>
            <Show when={!!descriptor()}>{rawToggle()}</Show>
          </Match>
          <Match when={identity().action === "call"}>
            <ToolParams input={visibleArgs()} />
            <Show when={props.output} fallback={
              <Show when={props.status === "completed"}>
                <ToolEmpty>{i18n.t("ui.tool.lazy.noOutput")}</ToolEmpty>
              </Show>
            }>
              <ToolBlock label={i18n.t("ui.basicTool.output")}>
                <SmartToolOutput output={props.output} />
              </ToolBlock>
            </Show>
          </Match>
        </Switch>
      </BasicTool>
    </div>
  )
}
