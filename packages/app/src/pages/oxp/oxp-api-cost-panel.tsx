import { createMemo, createSignal, For, Show } from "solid-js"
import type { OxpLocalDonor } from "./oxp-local-donor"
import {
  OXP_API_MODELS,
  valueOxpApiUsage,
  formatOxpDollar,
  type OxpContextTier,
} from "./oxp-api-equivalent"

/**
 * The local donor is an OBSERVED OpenFork cache/output ratio, used as a
 * counterfactual proxy for unseen ChatGPT accounting — not a claim of upstream
 * identity or cache behavior. A manual scenario remains available at all times.
 */
export function OxpApiCostPanel(props: {
  oxpTokens: number
  surroundingTokens: number
  donor?: OxpLocalDonor
  modelDonors?: Readonly<Record<string, OxpLocalDonor>>
}) {
  const [source, setSource] = createSignal<"local" | "manual">("local")
  const [surroundingOutputPercent, setSurroundingOutputPercent] = createSignal(10)
  const [cachedInputPercent, setCachedInputPercent] = createSignal(0)
  // OXP results/requests are not known to be repeated-prefix cache hits.
  // Never silently reuse whole-prompt local cache ratios for new tool payloads.
  const [oxpCachedInputPercent, setOxpCachedInputPercent] = createSignal(0)
  const [contextTier, setContextTier] = createSignal<OxpContextTier>("short")
  const useDonor = () => source() === "local" && !!props.donor
  const outputShare = () => useDonor() ? props.donor!.surroundingOutputPercent : surroundingOutputPercent()
  const cacheShare = () => useDonor() ? props.donor!.cachedInputPercent : cachedInputPercent()

  const costs = createMemo(() =>
    OXP_API_MODELS.map((model) => {
      const donor = props.modelDonors?.[model.id] ?? props.donor
      const assumptions = {
        surroundingOutputPercent: useDonor() && donor ? donor.surroundingOutputPercent : outputShare(),
        cachedInputPercent: useDonor() && donor ? donor.cachedInputPercent : cacheShare(),
        oxpCachedInputPercent: oxpCachedInputPercent(),
        contextTier: contextTier(),
      }
      return {
        ...valueOxpApiUsage(model, { oxp: props.oxpTokens, surrounding: props.surroundingTokens }, assumptions),
        donor: useDonor() ? donor : undefined,
      }
    }),
  )

  return (
    <section data-slot="oxp-api-cost" aria-label="Estimated API-equivalent costs">
      <header data-slot="oxp-api-cost-header">
        <div class="min-w-0">
          <strong>API-equivalent cost</strong>
          <span>Counterfactual · OpenAI Standard · not an actual ChatGPT charge</span>
        </div>
        <a href="https://developers.openai.com/api/docs/pricing" target="_blank" rel="noreferrer">
          API pricing ↗
        </a>
      </header>
      <div data-slot="oxp-api-cost-controls">
        <label>
          <span>Split source</span>
          <select
            aria-label="API pricing assumptions source"
            value={useDonor() ? "local" : "manual"}
            onChange={(event) => setSource(event.currentTarget.value as "local" | "manual")}
          >
            <Show when={props.donor}>
              <option value="local">Observed OpenFork proxy</option>
            </Show>
            <option value="manual">Manual scenario</option>
          </select>
        </label>
        <label>
          <span>Surrounding output</span>
          <select
            aria-label="Assumed share of surrounding tokens that are model output"
            value={String(useDonor() ? "proxy" : surroundingOutputPercent())}
            disabled={useDonor()}
            onChange={(event) => setSurroundingOutputPercent(Number(event.currentTarget.value))}
          >
            <Show when={useDonor()}>
              <option value="proxy">{props.modelDonors ? "Per-model local" : outputShare().toFixed(1) + "% · local"}</option>
            </Show>
            <option value="0">0% · all input</option>
            <option value="10">10% · scenario</option>
            <option value="20">20%</option>
            <option value="50">50%</option>
            <option value="100">100% · all output</option>
          </select>
        </label>
        <label>
          <span>Surrounding cache</span>
          <select
            aria-label="Assumed cached share of input tokens"
            value={String(useDonor() ? "proxy" : cachedInputPercent())}
            disabled={useDonor()}
            onChange={(event) => setCachedInputPercent(Number(event.currentTarget.value))}
          >
            <Show when={useDonor()}>
              <option value="proxy">{props.modelDonors ? "Per-model local" : cacheShare().toFixed(1) + "% · local"}</option>
            </Show>
            <option value="0">0% · uncached</option>
            <option value="50">50%</option>
            <option value="90">90%</option>
            <option value="100">100%</option>
          </select>
        </label>
        <label>
          <span>OXP input cache</span>
          <select
            aria-label="Assumed cached share of OXP tool payload input tokens"
            value={String(oxpCachedInputPercent())}
            onChange={(event) => setOxpCachedInputPercent(Number(event.currentTarget.value))}
          >
            <option value="0">0% · default</option>
            <option value="25">25% · scenario</option>
            <option value="50">50%</option>
            <option value="75">75%</option>
            <option value="100">100%</option>
          </select>
        </label>
        <label>
          <span>Context tier</span>
          <select
            aria-label="Assumed input tokens per model request"
            value={contextTier()}
            onChange={(event) => setContextTier(event.currentTarget.value as OxpContextTier)}
          >
            <option value="short">≤272K / request</option>
            <option value="long">&gt;272K / request</option>
          </select>
        </label>
      </div>
      <div data-slot="oxp-api-cost-scroll">
        <table data-slot="oxp-api-cost-table">
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col" title="Published short-context uncached input / output USD per million tokens">
                Input / output · $/1M
              </th>
              <th scope="col" title="OXP tool requests + results; both count as model input">
                OXP input
              </th>
               <th scope="col" title="Surrounding tokens valued using the chosen scenario">
                 Surrounding
               </th>
               <th scope="col" title="Local donor scope and observed generation count; hover for local cached and output shares">Local proxy</th>
               <th scope="col">Combined</th>
            </tr>
          </thead>
          <tbody>
            <For each={costs()}>
              {(entry) => (
                <tr>
                  <th scope="row">{entry.model.label}</th>
                  <td data-cell="rates">
                    {formatOxpDollar(entry.model.input)} / {formatOxpDollar(entry.model.output)}
                  </td>
                  <td>{formatOxpDollar(entry.oxp)}</td>
                   <td>{formatOxpDollar(entry.surrounding)}</td>
                   <td data-cell="rates" title={entry.donor
                     ? `OpenFork observations: ${entry.donor.cachedInputPercent.toFixed(1)}% cached input, ${entry.donor.surroundingOutputPercent.toFixed(1)}% output + reasoning`
                     : "Manual split assumption"}>
                     {entry.donor ? `${entry.donor.cohort === "exact-model" ? "Exact" : entry.donor.cohort === "gpt-6" ? "GPT-6" : "All"} · n=${entry.donor.messages.toLocaleString()}` : "Manual"}
                   </td>
                   <td data-cell="total">{formatOxpDollar(entry.total)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
      <p data-slot="oxp-api-cost-note">
        <Show when={useDonor() && props.donor}>
          {(donor) => (
            <span>Local proxy: {donor().messages.toLocaleString()} settled OpenFork generations
              ({donor().cohort === "gpt-6" ? "GPT-6 cohort" : "all-model fallback"}).
              Cached share: {donor().cachedInputPercent.toFixed(1)}%; output + reasoning share:
              {donor().surroundingOutputPercent.toFixed(1)}%. These are real local ratios,
              not measured ChatGPT ratios.{" "}
            </span>
          )}
        </Show>
         OXP request/result payloads are estimated INPUT tokens, independently assigned 0% caching by default.
         Locally observed cache ratios apply to surrounding prompt input only. The surrounding estimate has no
         observed upstream input/output/cache split; every valuation remains a scenario, even with local donors.
        Long-context rates apply to whole requests above 272K input tokens; aggregate totals cannot identify
        those requests. Excludes API tool fees, cache writes and processing-tier premiums.
      </p>
    </section>
  )
}
