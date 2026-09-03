import { For, Show } from "solid-js"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { Icon as LegacyIcon } from "@opencode-ai/ui/icon"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import { USAGE_WINDOWS } from "@/components/usage/use-usage-summary"

type Metric = "cost" | "tokens"

/** Deliberately narrower than `UsageSummaryResponse["projects"]` — the picker's
 * option list must come from a project source that isn't itself scoped by the
 * active project filter (see usage-page.tsx's `projectOptions` memo). */
export type UsageProjectOption = { projectID: string; name: string }

/** Dense single-row toolbar: breadcrumb title + date range on the left, every filter control right-aligned — replaces the panel version's three stacked rows now that full page width means they fit on one line. */
export function UsagePageHeader(props: {
  windowKey: string
  onWindowChange: (key: string) => void
  metric: Metric
  onMetricChange: (metric: Metric) => void
  projectID: string | null
  onProjectChange: (id: string | null) => void
  projects: UsageProjectOption[]
  since: number
  until: number
  isAllTime: boolean
  onRefresh: () => void
  loading: boolean
}) {
  const language = useLanguage()
  const rangeLabel = () => {
    if (props.isAllTime) return language.t("usage.window.all")
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }
    return `${new Date(props.since).toLocaleDateString(language.intl(), opts)} – ${new Date(props.until).toLocaleDateString(language.intl(), opts)}`
  }

  return (
    <div class="flex flex-wrap items-center gap-3">
      <div class="flex min-w-0 items-baseline gap-1.5">
        <h1 class="text-[16px] font-[650] leading-5 text-v2-text-text-base">{language.t("usage.panel.title")}</h1>
        <span class="text-[12px] font-[440] text-v2-text-text-faint">/</span>
        <span class="truncate text-[12px] font-[480] tabular-nums text-v2-text-text-muted">{rangeLabel()}</span>
      </div>

      <div class="flex flex-1 flex-wrap items-center justify-end gap-1.5">
        <div class="flex items-center rounded-md bg-v2-background-bg-layer-02 p-0.5">
          <button
            type="button"
            class="h-6 rounded-[5px] px-2.5 text-[11px] font-[560] leading-6 transition-colors"
            classList={{
              "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-switch-on)]": props.metric === "cost",
              "text-v2-text-text-muted": props.metric !== "cost",
            }}
            onClick={() => props.onMetricChange("cost")}
          >
            {language.t("usage.metric.cost")}
          </button>
          <button
            type="button"
            class="h-6 rounded-[5px] px-2.5 text-[11px] font-[560] leading-6 transition-colors"
            classList={{
              "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-switch-on)]": props.metric === "tokens",
              "text-v2-text-text-muted": props.metric !== "tokens",
            }}
            onClick={() => props.onMetricChange("tokens")}
          >
            {language.t("usage.metric.tokens")}
          </button>
        </div>

        <div class="flex items-center gap-0.5 rounded-md bg-v2-background-bg-layer-02 p-0.5">
          <For each={USAGE_WINDOWS}>
            {(option) => (
              <button
                type="button"
                class="h-6 rounded-[5px] px-2 text-[11px] font-[520] leading-6 tabular-nums transition-colors"
                classList={{
                  "bg-v2-background-bg-base text-v2-text-text-base shadow-[var(--v2-elevation-switch-on)]": props.windowKey === option.key,
                  "text-v2-text-text-muted hover:text-v2-text-text-base": props.windowKey !== option.key,
                }}
                onClick={() => props.onWindowChange(option.key)}
              >
                {language.t(option.labelKey)}
              </button>
            )}
          </For>
        </div>

        <UsageProjectMenu projectID={props.projectID} projects={props.projects} onChange={props.onProjectChange} />

        <TooltipV2 value={language.t("common.refresh")}>
          <IconButtonV2
            type="button"
            variant="ghost-muted"
            size="small"
            onClick={props.onRefresh}
            aria-label={language.t("common.refresh")}
            icon={<Icon name="outline-reset" />}
          />
        </TooltipV2>

        <Show when={props.loading}>
          <span class="flex size-7 shrink-0 items-center justify-center" role="status" aria-label={language.t("usage.loading")}>
            <Spinner class="size-4 text-v2-icon-icon-muted" />
          </span>
        </Show>
      </div>
    </div>
  )
}

/** Project filter — same MenuV2 dropdown used for the tab right-click context menu (and the workspace picker), instead of a native `<select>`. */
function UsageProjectMenu(props: {
  projectID: string | null
  projects: UsageProjectOption[]
  onChange: (id: string | null) => void
}) {
  const language = useLanguage()
  const selectedLabel = () => props.projects.find((project) => project.projectID === props.projectID)?.name ?? language.t("usage.project.all")

  return (
    <MenuV2 placement="bottom-end" gutter={4}>
      <MenuV2.Trigger
        class="flex h-7 min-w-0 max-w-40 items-center gap-1.5 rounded-md bg-v2-background-bg-layer-02 px-2 text-[11px] font-[500] text-v2-text-text-base outline-none hover:bg-v2-overlay-simple-overlay-hover data-[expanded]:bg-v2-overlay-simple-overlay-pressed"
        aria-label={language.t("usage.project.select")}
      >
        <span class="min-w-0 flex-1 truncate text-left">{selectedLabel()}</span>
        <LegacyIcon name="chevron-down" size="small" class="shrink-0 text-v2-icon-icon-muted" />
      </MenuV2.Trigger>
      <MenuV2.Portal>
        <MenuV2.Content class="w-56">
          <MenuV2.Item onSelect={() => props.onChange(null)}>
            <span class="min-w-0 flex-1 truncate">{language.t("usage.project.all")}</span>
            <Show when={props.projectID === null}>
              <LegacyIcon name="check" size="small" class="shrink-0" />
            </Show>
          </MenuV2.Item>
          <Show when={props.projects.length > 0}>
            <MenuV2.Separator />
            <For each={props.projects}>
              {(project) => (
                <MenuV2.Item onSelect={() => props.onChange(project.projectID)}>
                  <span class="min-w-0 flex-1 truncate">{project.name}</span>
                  <Show when={props.projectID === project.projectID}>
                    <LegacyIcon name="check" size="small" class="shrink-0" />
                  </Show>
                </MenuV2.Item>
              )}
            </For>
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
