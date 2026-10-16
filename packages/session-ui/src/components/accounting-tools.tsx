import { createMemo, For, Match, Show, Switch } from "solid-js"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { SmartToolOutput } from "./tool-output"
import {
  ToolBadge,
  ToolBlock,
  ToolBoundedList,
  ToolEmpty,
  ToolFields,
  ToolNotice,
  ToolRow,
  ToolStats,
  type Tone,
} from "./tool-parts"

type RecordLike = Record<string, any>

const asRecord = (value: unknown): RecordLike | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as RecordLike) : undefined

const asArray = (value: unknown): RecordLike[] =>
  Array.isArray(value) ? value.flatMap((item) => (asRecord(item) ? [item as RecordLike] : [])) : []

const finite = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback

const optionalFinite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined

const text = (value: unknown) => (typeof value === "string" ? value : undefined)

function compact(value: number) {
  const n = Math.abs(value)
  if (n >= 1_000_000_000) return (value / 1_000_000_000).toFixed(n >= 10_000_000_000 ? 1 : 2) + "B"
  if (n >= 1_000_000) return (value / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2) + "M"
  if (n >= 1_000) return (value / 1_000).toFixed(n >= 10_000 ? 1 : 2) + "K"
  return Math.round(value).toLocaleString()
}

function money(value: number) {
  if (!Number.isFinite(value)) return "$0"
  return "$" + (value > 0 && value < 0.01 ? value.toFixed(4) : value.toFixed(2))
}

const percent = (value: number | undefined, digits = 0) =>
  value === undefined ? "—" : Math.max(0, Math.min(100, value)).toFixed(digits) + "%"

function dateTime(value: unknown) {
  const n = optionalFinite(value)
  if (n === undefined) return "—"
  try {
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(n))
  } catch {
    return "—"
  }
}

function toneForRemaining(value: number | undefined): Tone {
  if (value === undefined) return "neutral"
  if (value <= 10) return "danger"
  if (value <= 30) return "warning"
  return "success"
}

function QuotaMeter(props: { value?: number }) {
  const width = createMemo(() => Math.max(0, Math.min(100, props.value ?? 0)))
  return (
    <span data-component="quota-meter" data-tone={toneForRemaining(props.value)}>
      <span data-slot="quota-meter-fill" style={{ width: width() + "%" }} />
    </span>
  )
}

function QuotaWindowRow(props: { window: RecordLike }) {
  const remaining = createMemo(() => optionalFinite(props.window.remainingPercent))
  return (
    <ToolRow
      lead={
        <ToolBadge tone={toneForRemaining(remaining())}>
          {percent(remaining(), remaining() !== undefined && remaining()! % 1 ? 1 : 0)}
        </ToolBadge>
      }
      primary={text(props.window.key) ?? "—"}
      secondary={<QuotaMeter value={remaining()} />}
      trailing={
        <span data-component="quota-row-meta">
          <Show when={props.window.resetAt}>{dateTime(props.window.resetAt)}</Show>
          <Show when={!props.window.resetAt && props.window.valueLabel}>{text(props.window.valueLabel)}</Show>
        </span>
      }
    />
  )
}

function QuotaProviderBody(props: { view: RecordLike; compact?: boolean }) {
  const i18n = useI18n()
  const windows = createMemo(() => asArray(props.view.windows))
  const accounts = createMemo(() => asArray(props.view.accounts))
  const models = createMemo(() => asArray(props.view.models))
  const configured = createMemo(() => props.view.configured === true)
  const ok = createMemo(() => props.view.ok === true)

  return (
    <div data-component="quota-provider-body">
      <ToolStats
        items={[
          {
            label: i18n.t("ui.tool.quota.status"),
            value: configured()
              ? ok()
                ? i18n.t("ui.tool.quota.available")
                : i18n.t("ui.tool.quota.unavailable")
              : i18n.t("ui.tool.quota.notConfigured"),
            tone: configured() ? (ok() ? "success" : "warning") : undefined,
          },
          ...(props.view.planLabel
            ? [{ label: i18n.t("ui.tool.quota.plan"), value: String(props.view.planLabel) }]
            : []),
          {
            label: i18n.t("ui.tool.quota.windows"),
            value: String(finite(props.view.totalWindows, windows().length)),
          },
        ]}
      />

      <Show when={props.view.error}>
        <ToolNotice tone="warning" message={String(props.view.error)} />
      </Show>

      <Show when={windows().length > 0} fallback={<ToolEmpty>{i18n.t("ui.tool.quota.noWindows")}</ToolEmpty>}>
        <ToolBoundedList items={windows()} limit={props.compact ? 3 : 8}>
          {(window) => <QuotaWindowRow window={window} />}
        </ToolBoundedList>
      </Show>

      <Show when={!props.compact && models().length > 0}>
        <ToolBlock
          label={i18n.t("ui.tool.quota.models")}
          trailing={props.view.omittedModels ? "+" + props.view.omittedModels : undefined}
        >
          <ToolBoundedList items={models()} limit={8}>
            {(model) => {
              const binding = asArray(model.windows)
                .map((row) => optionalFinite(row.remainingPercent))
                .filter((value): value is number => value !== undefined)
                .sort((a, b) => a - b)[0]
              return (
                <ToolRow
                  lead={<ToolBadge tone={toneForRemaining(binding)}>{percent(binding)}</ToolBadge>}
                  primary={text(model.model) ?? "—"}
                  secondary={model.promotionLabel ?? model.rateLabel}
                  trailing={
                    model.rateFree === true ? (
                      <ToolBadge tone="success">{i18n.t("ui.tool.quota.free")}</ToolBadge>
                    ) : undefined
                  }
                />
              )
            }}
          </ToolBoundedList>
        </ToolBlock>
      </Show>

      <Show when={!props.compact && accounts().length > 0}>
        <ToolBlock
          label={i18n.t("ui.tool.quota.accounts")}
          trailing={props.view.omittedAccounts ? "+" + props.view.omittedAccounts : undefined}
        >
          <ToolBoundedList items={accounts()} limit={8}>
            {(account) => {
              const modelRows = asArray(account.models)
              const remaining = optionalFinite(account.remainingPercent)
              return (
                <ToolRow
                  lead={
                    <ToolBadge tone={account.exhausted === true ? "danger" : toneForRemaining(remaining)}>
                      {account.kind === "zen"
                        ? (text(account.state) ?? "—")
                        : modelRows.length + " " + i18n.t("ui.tool.quota.models").toLowerCase()}
                    </ToolBadge>
                  }
                  primary={text(account.label) ?? text(account.accountID) ?? "—"}
                  secondary={text(account.accountID)}
                  trailing={remaining !== undefined ? percent(remaining) : undefined}
                />
              )
            }}
          </ToolBoundedList>
        </ToolBlock>
      </Show>

      <Show when={props.view.fetchedAt || props.view.nextRefreshAt}>
        <ToolFields
          items={[
            ...(props.view.fetchedAt
              ? [{ key: i18n.t("ui.tool.quota.fetched"), value: dateTime(props.view.fetchedAt) }]
              : []),
            ...(props.view.nextRefreshAt
              ? [{ key: i18n.t("ui.tool.quota.nextRefresh"), value: dateTime(props.view.nextRefreshAt) }]
              : []),
          ]}
        />
      </Show>
    </div>
  )
}

export function QuotaOutput(props: { output: string; metadata: RecordLike }) {
  const i18n = useI18n()
  const view = createMemo(() => asRecord(props.metadata.view))

  return (
    <Show when={view()} fallback={<SmartToolOutput output={props.output} />}>
      {(resolved) => (
        <Switch fallback={<SmartToolOutput output={props.output} />}>
          <Match when={resolved().kind === "providers"}>
            <div data-component="quota-tool-output">
              <ToolStats
                items={[
                  { label: i18n.t("ui.tool.quota.providers"), value: String(asArray(resolved().providers).length) },
                  {
                    label: i18n.t("ui.tool.quota.configured"),
                    value: String(asArray(resolved().providers).filter((provider) => provider.configured === true).length),
                    tone: "success",
                  },
                ]}
              />
              <ToolBoundedList items={asArray(resolved().providers)} limit={12}>
                {(provider) => (
                  <ToolRow
                    lead={
                      <ToolBadge tone={provider.configured === true ? "success" : "neutral"}>
                        {provider.configured === true
                          ? i18n.t("ui.tool.quota.configured")
                          : i18n.t("ui.tool.quota.notConfigured")}
                      </ToolBadge>
                    }
                    primary={text(provider.providerName) ?? text(provider.providerID) ?? "—"}
                    secondary={text(provider.providerID)}
                  />
                )}
              </ToolBoundedList>
            </div>
          </Match>

          <Match when={resolved().kind === "provider"}>
            <div data-component="quota-tool-output">
              <QuotaProviderBody view={resolved()} />
            </div>
          </Match>

          <Match when={resolved().kind === "overview"}>
            <div data-component="quota-tool-output">
              <ToolStats
                items={[
                  { label: i18n.t("ui.tool.quota.providers"), value: String(asArray(resolved().providers).length) },
                  {
                    label: i18n.t("ui.tool.quota.failures"),
                    value: String(asArray(resolved().failures).length),
                    tone: asArray(resolved().failures).length ? "warning" : "success",
                  },
                ]}
              />
              <For each={asArray(resolved().providers)}>
                {(provider) => (
                  <ToolBlock
                    label={text(provider.providerName) ?? text(provider.providerID) ?? "—"}
                    trailing={
                      <ToolBadge tone={provider.ok === true ? "success" : "warning"}>
                        {text(provider.providerID) ?? "—"}
                      </ToolBadge>
                    }
                  >
                    <QuotaProviderBody view={provider} compact />
                  </ToolBlock>
                )}
              </For>
              <Show when={asArray(resolved().failures).length}>
                <ToolBlock label={i18n.t("ui.tool.quota.failures")}>
                  <ToolBoundedList items={asArray(resolved().failures)} limit={8}>
                    {(failure) => (
                      <ToolRow
                        lead={<ToolBadge tone="warning">{i18n.t("ui.tool.quota.unavailable")}</ToolBadge>}
                        primary={text(failure.providerID) ?? "—"}
                        secondary={text(failure.error)}
                      />
                    )}
                  </ToolBoundedList>
                </ToolBlock>
              </Show>
            </div>
          </Match>

          <Match when={resolved().kind === "resets"}>
            <div data-component="quota-tool-output">
              <ToolStats
                items={[
                  { label: i18n.t("ui.tool.quota.resets"), value: String(finite(resolved().totalOccurrences)) },
                  {
                    label: i18n.t("ui.tool.quota.failures"),
                    value: String(asArray(resolved().failures).length),
                    tone: asArray(resolved().failures).length ? "warning" : "success",
                  },
                ]}
              />
              <Show
                when={asArray(resolved().occurrences).length > 0}
                fallback={<ToolEmpty>{i18n.t("ui.tool.quota.noResets")}</ToolEmpty>}
              >
                <ToolBoundedList items={asArray(resolved().occurrences)} limit={12}>
                  {(occurrence) => (
                    <ToolRow
                      lead={<ToolBadge>{text(occurrence.scope) ?? "—"}</ToolBadge>}
                      primary={text(occurrence.providerName) ?? text(occurrence.providerID) ?? "—"}
                      secondary={text(occurrence.model) ?? text(occurrence.accountLabel)}
                      trailing={dateTime(occurrence.resetAt)}
                    />
                  )}
                </ToolBoundedList>
              </Show>
            </div>
          </Match>
        </Switch>
      )}
    </Show>
  )
}

function totalTokenCount(tokens: RecordLike | undefined) {
  if (!tokens) return 0
  return finite(tokens.input) + finite(tokens.cacheRead) + finite(tokens.cacheWrite) + finite(tokens.output) + finite(tokens.reasoning)
}

function usageMetric(point: RecordLike, metric: string) {
  if (metric === "tokens") return finite(point.tokens)
  if (metric === "messages") return finite(point.messages)
  return finite(point.cost) + finite(point.estimatedCost)
}

function UsageTimeline(props: { points: RecordLike[]; metric: string }) {
  const i18n = useI18n()
  const visible = createMemo(() => {
    if (props.points.length <= 60) return props.points
    const sampled: RecordLike[] = []
    for (let index = 0; index < 60; index++) {
      const source = Math.round((index * (props.points.length - 1)) / 59)
      if (props.points[source] && sampled[sampled.length - 1] !== props.points[source]) sampled.push(props.points[source]!)
    }
    return sampled
  })
  const max = createMemo(() => Math.max(1, ...visible().map((point) => usageMetric(point, props.metric))))

  return (
    <div data-component="usage-micro-timeline">
      <div data-slot="usage-bars" role="img" aria-label={i18n.t("ui.tool.usage.timeline")}>
        <For each={visible()}>
          {(point) => {
            const value = () => usageMetric(point, props.metric)
            const height = () => Math.max(value() > 0 ? 5 : 1, Math.min(100, (value() / max()) * 100))
            return (
              <span
                data-slot="usage-bar"
                style={{ height: height() + "%" }}
                title={dateTime(point.start) + " · " + props.metric + ": " + (props.metric === "cost" ? money(value()) : compact(value()))}
              />
            )
          }}
        </For>
      </div>
      <Show when={visible().length > 0}>
        <div data-slot="usage-timeline-axis">
          <span>{dateTime(visible()[0]?.start)}</span>
          <span>{dateTime(visible()[visible().length - 1]?.start)}</span>
        </div>
      </Show>
    </div>
  )
}

function UsageTotals(props: { view: RecordLike }) {
  const i18n = useI18n()
  const totals = createMemo(() => asRecord(props.view.totals) ?? {})
  const rates = createMemo(() => asRecord(props.view.rates) ?? {})
  const pricing = createMemo(() => asRecord(props.view.pricing) ?? {})
  const tokens = createMemo(() => asRecord(totals().tokens))
  const model = createMemo(() => asRecord(props.view.mostUsedModel))
  const spend = createMemo(() => finite(totals().cost) + finite(totals().estimatedCost))

  return (
    <>
      <ToolStats
        items={[
          { label: i18n.t("ui.tool.usage.spend"), value: money(spend()), tone: spend() > 0 ? "accent" : undefined },
          { label: i18n.t("ui.tool.usage.tokens"), value: compact(totalTokenCount(tokens())) },
          { label: i18n.t("ui.tool.usage.turns"), value: compact(finite(totals().messages)) },
          { label: i18n.t("ui.tool.usage.sessions"), value: compact(finite(totals().sessions)) },
          { label: i18n.t("ui.tool.usage.cacheHit"), value: percent(finite(rates().cacheHitRate) * 100, 1) },
        ]}
      />
      <ToolFields
        items={[
          {
            key: i18n.t("ui.tool.usage.pricing"),
            value: (text(pricing().mode) ?? "—") + " · " + percent(finite(pricing().coverage) * 100, 1),
          },
          { key: i18n.t("ui.tool.usage.cacheSavings"), value: money(finite(rates().cacheSavings)) },
          ...(model()
            ? [{
                key: i18n.t("ui.tool.usage.mostUsed"),
                value:
                  (text(model()!.providerID) ?? "?") +
                  "/" +
                  (text(model()!.modelID) ?? "?") +
                  " · " +
                  compact(finite(model()!.messages)) +
                  " · " +
                  percent(finite(model()!.share) * 100, 1),
                mono: true,
              }]
            : []),
        ]}
      />
    </>
  )
}

function UsageRows(props: { view: RecordLike; maintenance?: boolean }) {
  const i18n = useI18n()
  const rows = createMemo(() => asArray(props.view.rows))
  return (
    <Show when={rows().length > 0} fallback={<ToolEmpty>{i18n.t("ui.tool.usage.noRows")}</ToolEmpty>}>
      <ToolBoundedList items={rows()} limit={10}>
        {(row) => {
          const spend = finite(row.cost) + finite(row.estimatedCost)
          return (
            <ToolRow
              lead={<ToolBadge tone={spend > 0 ? "accent" : "neutral"}>{money(spend)}</ToolBadge>}
              primary={text(row.label) ?? text(row.key) ?? "—"}
              secondary={compact(finite(row.tokens)) + " " + i18n.t("ui.tool.usage.tokens").toLowerCase()}
              trailing={
                props.maintenance
                  ? compact(finite(row.requests)) + " " + i18n.t("ui.tool.usage.requests").toLowerCase()
                  : compact(finite(row.messages)) + " " + i18n.t("ui.tool.usage.turns").toLowerCase()
              }
            />
          )
        }}
      </ToolBoundedList>
    </Show>
  )
}

export function UsageOutput(props: { output: string; metadata: RecordLike }) {
  const i18n = useI18n()
  const view = createMemo(() => asRecord(props.metadata.view))

  return (
    <Show when={view()} fallback={<SmartToolOutput output={props.output} />}>
      {(resolved) => (
        <div data-component="usage-tool-output">
          <Switch fallback={<SmartToolOutput output={props.output} />}>
            <Match when={resolved().kind === "totals"}>
              <UsageTotals view={resolved()} />
            </Match>

            <Match when={resolved().kind === "breakdown"}>
              <ToolStats
                items={[
                  { label: i18n.t("ui.tool.usage.dimension"), value: text(resolved().dimension) ?? "—" },
                  {
                    label: i18n.t("ui.tool.usage.rows"),
                    value: asArray(resolved().rows).length + "/" + finite(resolved().totalRows),
                  },
                ]}
              />
              <UsageRows view={resolved()} />
            </Match>

            <Match when={resolved().kind === "timeline"}>
              <ToolStats
                items={[
                  { label: i18n.t("ui.tool.usage.metric"), value: text(resolved().metric) ?? "—" },
                  { label: i18n.t("ui.tool.usage.resolution"), value: text(resolved().resolution) ?? "—" },
                  {
                    label: i18n.t("ui.tool.usage.points"),
                    value: asArray(resolved().points).length + "/" + finite(resolved().sourcePoints),
                  },
                ]}
              />
              <UsageTimeline points={asArray(resolved().points)} metric={text(resolved().metric) ?? "cost"} />
            </Match>

            <Match when={resolved().kind === "maintenance"}>
              {(() => {
                const totals = asRecord(resolved().totals) ?? {}
                return (
                  <>
                    <ToolStats
                      items={[
                        {
                          label: i18n.t("ui.tool.usage.spend"),
                          value: money(finite(totals.cost) + finite(totals.estimatedCost)),
                          tone: "accent",
                        },
                        { label: i18n.t("ui.tool.usage.tokens"), value: compact(finite(totals.totalTokens)) },
                        { label: i18n.t("ui.tool.usage.requests"), value: compact(finite(totals.requests)) },
                        { label: i18n.t("ui.tool.usage.sessions"), value: compact(finite(totals.sessions)) },
                      ]}
                    />
                    <UsageRows view={resolved()} maintenance />
                  </>
                )
              })()}
            </Match>

            <Match when={resolved().kind === "profile"}>
              <ToolStats
                items={[
                  {
                    label: i18n.t("ui.tool.usage.models"),
                    value: asArray(resolved().models).length + "/" + finite(resolved().totalModels),
                  },
                ]}
              />
              <ToolBoundedList items={asArray(resolved().models)} limit={10}>
                {(model) => (
                  <ToolRow
                    lead={<ToolBadge tone="accent">{money(finite(model.averageCost))}</ToolBadge>}
                    primary={(text(model.providerID) ?? "?") + "/" + (text(model.modelID) ?? "?")}
                    secondary={percent(finite(model.cacheHitRate) * 100, 1) + " " + i18n.t("ui.tool.usage.cacheHit").toLowerCase()}
                    trailing={compact(finite(model.costSamples)) + " " + i18n.t("ui.tool.usage.samples").toLowerCase()}
                  />
                )}
              </ToolBoundedList>
            </Match>

            <Match when={resolved().kind === "context" && resolved().missing === true}>
              <ToolEmpty>{i18n.t("ui.tool.usage.contextMissing")}</ToolEmpty>
            </Match>

            <Match when={resolved().kind === "context"}>
              {(() => {
                const totals = asRecord(resolved().totals) ?? {}
                const tokens = asRecord(totals.tokens)
                const breakdown = asRecord(resolved().breakdown) ?? {}
                return (
                  <>
                    <ToolStats
                      items={[
                        { label: i18n.t("ui.tool.usage.cost"), value: money(finite(totals.cost)), tone: "accent" },
                        { label: i18n.t("ui.tool.usage.tokens"), value: compact(totalTokenCount(tokens)) },
                        { label: i18n.t("ui.tool.usage.messages"), value: compact(finite(totals.messages)) },
                        { label: i18n.t("ui.tool.usage.toolCalls"), value: compact(finite(totals.toolCalls)) },
                        { label: i18n.t("ui.tool.usage.models"), value: compact(finite(resolved().totalModels)) },
                      ]}
                    />
                    <ToolFields
                      items={[
                        {
                          key: i18n.t("ui.tool.usage.session"),
                          value: text(resolved().sessionID) ?? "—",
                          mono: true,
                        },
                        {
                          key: i18n.t("ui.tool.usage.contextParts"),
                          value:
                            i18n.t("ui.tool.usage.part.system") +
                            " " +
                            finite(breakdown.system) +
                            " · " +
                            i18n.t("ui.tool.usage.part.user") +
                            " " +
                            finite(breakdown.user) +
                            " · " +
                            i18n.t("ui.tool.usage.part.assistant") +
                            " " +
                            finite(breakdown.assistant) +
                            " · " +
                            i18n.t("ui.tool.usage.part.tool") +
                            " " +
                            finite(breakdown.tool),
                        },
                      ]}
                    />
                  </>
                )
              })()}
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  )
}
