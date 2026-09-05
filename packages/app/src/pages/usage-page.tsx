import { createMemo, createSignal, ErrorBoundary, Match, startTransition, Switch } from "solid-js"
import { Icon } from "@opencode-ai/ui/icon"
import { TabsV2 } from "@opencode-ai/ui/v2/tabs-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { useLanguage } from "@/context/language"
import { useLayout } from "@/context/layout"
import { createUsageSummary, USAGE_WINDOWS } from "@/components/usage/use-usage-summary"
import { groupModelsByName, type ModelGroup } from "@/components/usage/usage-model-groups"
import { createCatalogIdentify, type CatalogModel } from "@/components/usage/usage-model-identity"
import { UsagePageHeader, type UsageProjectOption } from "@/pages/usage/usage-page-header"
import { UsagePageHero } from "@/pages/usage/usage-page-hero"
import { UsageOverviewCache, UsageOverviewStats } from "@/pages/usage/usage-page-overview"
import { UsageSubsidyPanel } from "@/pages/usage/usage-page-subsidy"
import { UsagePageModels } from "@/pages/usage/usage-page-models"
import { UsagePageActivity } from "@/pages/usage/usage-page-activity"
import { createUsageValuation } from "@/pages/usage/use-usage-valuation"

type Metric = "cost" | "tokens"
type Section = "overview" | "models" | "activity"

export function UsagePage() {
  const language = useLanguage()
  const layout = useLayout()
  const [windowKey, setWindowKey] = createSignal<string>("30d")
  const [projectID, setProjectID] = createSignal<string | null>(null)
  const [metric, setMetric] = createSignal<Metric>("cost")
  const [refreshTick, setRefreshTick] = createSignal(0)
  const [section, setSection] = createSignal<Section>("overview")

  const windowDef = createMemo(() => USAGE_WINDOWS.find((w) => w.key === windowKey()) ?? USAGE_WINDOWS[5])
  const summary = createUsageSummary({ windowDef, projectID, refreshTick })

  // The usage-summary response's own `projects[]` field is scoped by the
  // active project filter (collapses to <=1 entry once a project is
  // selected), so the picker can't use it to enumerate its own choices —
  // that would make selecting a project hide every other project from the
  // dropdown. Source options from the always-global project list instead.
  // `id` is optional on LocalProject (unsynced projects have none); those
  // can't have attributed usage rows anyway, so dropping them is safe.
  const projectOptions = createMemo<UsageProjectOption[]>(() =>
    layout.projects
      .list()
      .filter((project): project is typeof project & { id: string } => !!project.id)
      .map((project) => ({ projectID: project.id, name: project.name || project.worktree }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  )

  // Solid resource accessors re-throw the fetch error on every read once a
  // resource has errored (that's what lets Suspense/ErrorBoundary catch it) —
  // so any *unconditional* `summary()` read (header props, effects) would
  // throw past this page's own ErrorBoundary before the error Match branch
  // below ever gets a chance to render it locally. Route every read through
  // this instead of `summary()` directly.
  const data = () => (summary.error ? undefined : summary())

  // Provider ids are stable, compact, and already the canonical labels used
  // by the selector and server data — no need to resolve a display name.
  const providerName = (id: string) => id

  // Built once for the whole page: the provider catalog, the pricing-inference
  // fallback maps, and the free/subsidised usage valuation derived from them.
  // Every catalog consumer on the page goes through this, so they can never
  // disagree about a model's identity or what it is worth.
  const valuation = createUsageValuation(() => data()?.models ?? [])

  // Model *naming* shares the same catalog as model *pricing*. It previously
  // came from `useModels`, which only exposes connected providers — so on this
  // directory-agnostic route the breakdown fell back to raw provider ids
  // ("hy4-preview#ctx-1000000@wb-…") instead of canonical names.
  const catalog = createMemo<CatalogModel[]>(() =>
    valuation.catalog().map((m) => ({ providerID: m.provider.id, modelID: m.id, name: m.name, family: m.family })),
  )
  const identify = createMemo(() => createCatalogIdentify(catalog()))
  const modelGroups = createMemo<ModelGroup[]>(() => groupModelsByName(data()?.models ?? [], identify()))

  const totalCost = () => {
    const value = data()
    if (!value) return 0
    return value.totals.cost + value.totals.estimatedCost
  }
  const tokenTotal = () => {
    const value = data()
    if (!value) return 0
    const tokens = value.totals.tokens
    return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output + tokens.reasoning
  }
  const isAllTime = () => windowDef().key === "all"

  const pricingLabel = () => {
    const value = data()
    if (!value) return ""
    switch (value.pricing.mode) {
      case "estimated":
        return language.t("usage.pricing.estimated")
      case "mixed":
        return language.t("usage.pricing.mixed")
      case "unpriced":
        return language.t("usage.pricing.unpriced")
      default:
        return language.t("usage.pricing.recorded")
    }
  }

  return (
    <div
      data-component="usage-dashboard"
      class="m-2 flex min-h-0 flex-1 flex-col self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
    >
      <ErrorBoundary
        fallback={(error) => {
          console.error("[usage-page] render failure", error)
          return (
            <div class="flex h-full flex-col items-center justify-center gap-1 px-3">
              <span class="text-[11px] font-[600] uppercase leading-3 tracking-[0.02em] text-v2-state-fg-danger">
                {language.t("usage.error")}
              </span>
              <span class="max-w-full truncate text-[11px] font-[440] leading-3 text-v2-text-text-faint">
                {error instanceof Error ? error.message : String(error)}
              </span>
            </div>
          )
        }}
      >
        {/* Toolbar stays put above the rail+content split — filters apply
        regardless of which dashboard section is active, so it belongs
        outside the section switcher, not scrolled away with content. */}
        <div class="shrink-0 border-b border-[var(--usage-line)] bg-[var(--usage-panel)] px-6 py-3">
          <UsagePageHeader
            windowKey={windowKey()}
            onWindowChange={(key) => void startTransition(() => setWindowKey(key))}
            metric={metric()}
            onMetricChange={(value) => void startTransition(() => setMetric(value))}
            projectID={projectID()}
            onProjectChange={(id) => void startTransition(() => setProjectID(id))}
            projects={projectOptions()}
            since={data()?.since ?? Date.now()}
            until={data()?.until ?? Date.now()}
            isAllTime={isAllTime()}
            onRefresh={() => void startTransition(() => setRefreshTick((value) => value + 1))}
            loading={summary.loading}
          />
        </div>

        <div class="min-h-0 flex-1">
          <Switch>
            <Match when={summary.error}>
              <div class="flex h-full items-center justify-center py-16 text-center text-[11px] font-[440] text-v2-text-text-faint">
                {language.t("usage.error")}
              </div>
            </Match>
            <Match when={summary.loading && !data()}>
              <div class="flex h-full min-h-40 items-center justify-center gap-2 py-16 text-[11px] font-[440] text-v2-text-text-faint">
                <Spinner class="size-4 text-v2-icon-icon-muted" />
                {language.t("usage.loading")}
              </div>
            </Match>
            <Match when={data()}>
              <TabsV2
                orientation="vertical"
                variant="settings"
                value={section()}
                onChange={(value) => void startTransition(() => setSection(value as Section))}
                class="h-full"
              >
                <TabsV2.List>
                  <TabsV2.Trigger value="overview">
                    <Icon name="status" />
                    {language.t("usage.nav.overview")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="models">
                    <Icon name="models" />
                    {language.t("usage.nav.models")}
                  </TabsV2.Trigger>
                  <TabsV2.Trigger value="activity">
                    <Icon name="usage" />
                    {language.t("usage.nav.activity")}
                  </TabsV2.Trigger>
                </TabsV2.List>

                <TabsV2.Content value="overview">
                  <div class="mx-auto flex w-full max-w-[1400px] flex-col gap-3 p-4">
                    <UsagePageHero
                      data={data()!}
                      metric={metric()}
                      providerName={providerName}
                      totalCost={totalCost()}
                      tokenTotal={tokenTotal()}
                      pricingLabel={pricingLabel()}
                      resolution={windowDef().resolution}
                    />
                    <UsageOverviewStats data={data()!} valuation={valuation} />
                    <div class="grid grid-cols-1 gap-3 xl:grid-cols-2">
                      <UsageOverviewCache data={data()!} modelGroups={modelGroups()} />
                      <UsageSubsidyPanel valuation={valuation} />
                    </div>
                  </div>
                </TabsV2.Content>

                <TabsV2.Content value="models">
                  <div class="mx-auto flex w-full max-w-[1400px] flex-col gap-3 p-4">
                    <UsagePageModels
                      data={data()!}
                      modelGroups={modelGroups()}
                      valuation={valuation}
                      providerName={providerName}
                    />
                  </div>
                </TabsV2.Content>

                <TabsV2.Content value="activity">
                  <div class="mx-auto flex w-full max-w-[1400px] flex-col gap-3 p-4">
                    <UsagePageActivity data={data()!} metric={metric()} projectID={projectID()} />
                  </div>
                </TabsV2.Content>
              </TabsV2>
            </Match>
            <Match when={true}>
              <div class="flex h-full items-center justify-center py-16 text-center text-[11px] font-[440] text-v2-text-text-faint">
                {language.t("usage.empty")}
              </div>
            </Match>
          </Switch>
        </div>
      </ErrorBoundary>
    </div>
  )
}
