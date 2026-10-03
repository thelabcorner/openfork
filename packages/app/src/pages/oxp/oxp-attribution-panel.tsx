import type { OxpAttributionSnapshot } from "@opencode-ai/sdk/v2/client"
import { For, Show } from "solid-js"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { useLanguage } from "@/context/language"
import "./oxp-attribution.css"

type Source = OxpAttributionSnapshot["totals"]["bySource"][number]["source"]

const SOURCE_ORDER: readonly Source[] = [
  "observed_boundary",
  "historical_detail",
  "calibrated_surrogate",
  "calibrated_donor",
]

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function compact(value: unknown) {
  const n = finite(value)
  const abs = Math.abs(n)
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 1 : 2)}B`
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`
  if (abs >= 1_000) return `${(n / 1_000).toFixed(abs >= 10_000 ? 1 : 2)}k`
  return n.toFixed(abs < 10 && n % 1 ? 1 : 0)
}

function percent(value: number, total: number) {
  if (!(total > 0)) return "—"
  return `${((value / total) * 100).toFixed(value / total < 0.01 ? 1 : 0)}%`
}

function sourceLabel(source: Source) {
  switch (source) {
    case "observed_boundary":
      return "Observed boundary"
    case "historical_detail":
      return "Historical exact"
    case "calibrated_surrogate":
      return "Calibrated surrogate"
    case "calibrated_donor":
      return "Calibrated donor"
  }
}

function sourceTone(source: Source) {
  if (source === "observed_boundary") return "exact"
  if (source === "historical_detail") return "history"
  return "estimated"
}

function Metric(props: { label: string; value: string; detail?: string; tooltip?: string; primary?: boolean }) {
  return (
    <div data-slot="oxp-attribution-stat" data-primary={props.primary ? "true" : undefined}>
      <div class="flex min-w-0 items-center gap-1">
        <span data-slot="oxp-attribution-stat-label">{props.label}</span>
        <Show when={props.tooltip}>
          {(tip) => (
            <TooltipV2 value={<div class="max-w-72 text-11-regular">{tip()}</div>}>
              <span data-slot="oxp-attribution-help" tabindex={0}>
                <Icon name="help" size="small" />
              </span>
            </TooltipV2>
          )}
        </Show>
      </div>
      <span data-slot="oxp-attribution-stat-value">{props.value}</span>
      <Show when={props.detail}>
        <span data-slot="oxp-attribution-stat-detail">{props.detail}</span>
      </Show>
    </div>
  )
}

export function OxpAttributionPanel(props: {
  snapshot?: OxpAttributionSnapshot
  loading?: boolean
  error?: unknown
  onRefresh?: () => void
  title?: string
}) {
  const language = useLanguage()
  const snapshot = () => props.snapshot
  const totalSourceTokens = () => snapshot()?.totals.bySource.reduce((sum, row) => sum + finite(row.tokens), 0) ?? 0
  const sourceRows = () => {
    const rows = new Map(snapshot()?.totals.bySource.map((row) => [row.source, row]))
    return SOURCE_ORDER.map((source) => rows.get(source)).filter(
      (row): row is NonNullable<typeof row> => !!row && (row.uniqueChars > 0 || row.tokens > 0),
    )
  }

  return (
    <section data-component="oxp-attribution">
      <header data-slot="oxp-attribution-header">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <h2 data-slot="oxp-attribution-title">{props.title ?? language.t("oxpActivity.attribution.title")}</h2>
            <span data-slot="oxp-attribution-badge" data-tone="model">
              {language.t("oxpActivity.attribution.modeled")}
            </span>
          </div>
          <p data-slot="oxp-attribution-subtitle">{language.t("oxpActivity.attribution.subtitle")}</p>
        </div>
        <button
          type="button"
          data-slot="oxp-attribution-refresh"
          disabled={props.loading}
          onClick={() => props.onRefresh?.()}
        >
          {props.loading
            ? language.t("oxpActivity.attribution.refreshing")
            : language.t("oxpActivity.attribution.refresh")}
        </button>
      </header>

      <Show when={props.error}>
        <div data-slot="oxp-attribution-state" data-tone="danger">
          {language.t("oxpActivity.attribution.error")}
        </div>
      </Show>

      <Show
        when={snapshot()}
        fallback={
          <div data-slot="oxp-attribution-state">
            {props.loading
              ? language.t("oxpActivity.attribution.loading")
              : language.t("oxpActivity.attribution.empty")}
          </div>
        }
      >
        {(value) => (
          <>
            <div data-slot="oxp-attribution-stats">
              <Metric
                primary
                label={language.t("oxpActivity.attribution.exposure")}
                value={compact(value().totals.tokens)}
                detail={language.t("oxpActivity.attribution.tokenEquivalent")}
                tooltip={language.t("oxpActivity.attribution.exposureHelp")}
              />
              <Metric
                label={language.t("oxpActivity.attribution.unique")}
                value={compact(value().totals.uniqueTokens)}
                detail={language.t("oxpActivity.attribution.tokenEquivalent")}
                tooltip={language.t("oxpActivity.attribution.uniqueHelp")}
              />
              <Metric
                label={language.t("oxpActivity.attribution.amplification")}
                value={value().totals.amplification === null ? "—" : `${value().totals.amplification.toFixed(2)}×`}
                detail={language.t("oxpActivity.attribution.residency")}
              />
              <Metric
                label={language.t("oxpActivity.attribution.rounds")}
                value={compact(value().totals.inferredRounds)}
                detail={language.t("oxpActivity.attribution.inferred")}
              />
              <Metric
                label={language.t("oxpActivity.attribution.calls")}
                value={compact(value().totals.calls)}
                detail={language.t("oxpActivity.attribution.footprintInputs")}
              />
            </div>

            <div data-slot="oxp-attribution-grid">
              <section data-slot="oxp-attribution-section">
                <header data-slot="oxp-attribution-section-header">
                  <span>{language.t("oxpActivity.attribution.byTool")}</span>
                  <span>{value().totals.byTool.length}</span>
                </header>
                <div data-slot="oxp-attribution-table-wrap">
                  <table data-slot="oxp-attribution-table">
                    <thead>
                      <tr>
                        <th>{language.t("oxpActivity.attribution.tool")}</th>
                        <th>{language.t("oxpActivity.attribution.calls")}</th>
                        <th>{language.t("oxpActivity.attribution.uniqueShort")}</th>
                        <th>{language.t("oxpActivity.attribution.exposureShort")}</th>
                        <th>{language.t("oxpActivity.attribution.share")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <For each={value().totals.byTool}>
                        {(row) => (
                          <tr>
                            <td data-cell="name">{row.tool}</td>
                            <td>{row.calls.toLocaleString(language.intl())}</td>
                            <td>{compact(row.uniqueTokens)}</td>
                            <td>{compact(row.tokens)}</td>
                            <td>{percent(row.tokens, value().totals.tokens)}</td>
                          </tr>
                        )}
                      </For>
                    </tbody>
                  </table>
                </div>
              </section>

              <div data-slot="oxp-attribution-side">
                <section data-slot="oxp-attribution-section">
                  <header data-slot="oxp-attribution-section-header">
                    <span>{language.t("oxpActivity.attribution.provenance")}</span>
                    <span>
                      {value().coverage.complete
                        ? language.t("oxpActivity.attribution.coverageComplete")
                        : language.t("oxpActivity.attribution.coverageMixed")}
                    </span>
                  </header>
                  <div data-slot="oxp-attribution-source-list">
                    <For each={sourceRows()}>
                      {(row) => (
                        <div data-slot="oxp-attribution-source-row">
                          <span data-slot="oxp-attribution-badge" data-tone={sourceTone(row.source)}>
                            {sourceLabel(row.source)}
                          </span>
                          <span>{compact(row.tokens)}</span>
                          <span>{percent(row.tokens, totalSourceTokens())}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </section>

                <section data-slot="oxp-attribution-section">
                  <header data-slot="oxp-attribution-section-header">
                    <span>{language.t("oxpActivity.attribution.sensitivity")}</span>
                    <span>ρ</span>
                  </header>
                  <div data-slot="oxp-attribution-sensitivity">
                    <For each={[value().sensitivity.low, value().sensitivity.calibrated, value().sensitivity.high]}>
                      {(point) => (
                        <div
                          data-slot="oxp-attribution-sensitivity-row"
                          data-active={point.rho === value().sensitivity.calibrated.rho ? "true" : undefined}
                        >
                          <span>ρ {point.rho.toFixed(2)}</span>
                          <span>{compact(point.tokens)}</span>
                        </div>
                      )}
                    </For>
                  </div>
                </section>

                <section data-slot="oxp-attribution-method">
                  <div>
                    <span>{language.t("oxpActivity.attribution.model")}</span>
                    <strong>Geometric residency · ρ {value().model.rho.toFixed(2)}</strong>
                  </div>
                  <div>
                    <span>{language.t("oxpActivity.attribution.calibration")}</span>
                    <strong>{value().model.calibration.observations.toLocaleString(language.intl())} calls</strong>
                  </div>
                  <div>
                    <span>{language.t("oxpActivity.attribution.causal")}</span>
                    <strong>{language.t("oxpActivity.attribution.traceUnavailable")}</strong>
                  </div>
                  <div>
                    <span>{language.t("oxpActivity.attribution.schemaTax")}</span>
                    <strong>
                      {value().model.components.availabilitySchema
                        ? language.t("oxpActivity.attribution.included")
                        : language.t("oxpActivity.attribution.notMeasured")}
                    </strong>
                  </div>
                  <p>{language.t("oxpActivity.attribution.methodNote")}</p>
                </section>
              </div>
            </div>
          </>
        )}
      </Show>
    </section>
  )
}
