# OXP API-equivalent valuation

## Scope

The Usage → OXP Context pane compares **four counterfactual OpenAI API models**:
`gpt-6-luna`, `gpt-6-sol`, `gpt-6-astra`, and `gpt-6.1-sol`.
These are **not claims about which model a ChatGPT conversation actually used**,
and the displayed USD figures are **not charges**.

Pricing authority: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing),
verified 2026-10-11, Standard processing, USD per 1M tokens.

| Model | Input | Cached input | Output |
| --- | ---: | ---: | ---: |
| GPT-6 Luna | 0.10 | 0.01 | 0.50 |
| GPT-6 Sol | 2.00 | 0.20 | 10.00 |
| GPT-6 Astra | 10.00 | 1.00 | 50.00 |
| GPT-6.1 Sol | 2.00 | 0.10 | 10.00 |

> Rates are local snapshots: review/update when official prices change.
> Do not adopt arbitrary third-party/provider-route prices for these comparisons.

## Telemetry boundary

- `totals.tokens` covers OXP invocation request/result payload character mass
  projected into tokens. These are **model input** for the counterfactual;
  payload measurements can be observational, historical, or donor-calibrated.
- `totals.estimatedSurroundingTokens` is the remainder of the paired-OpenFork
  learned estimate of **total** surrounding token usage. This is not a direct
  ChatGPT token counter. It has no verified input, output, cache-hit or
  per-request context breakdown.
- `totals.estimatedTotalTokens` aggregates both classes. The valuation uses
  only the first two to prevent double counting.
- No residency multiplier or duplicated tool-result history. Tool schemas
  and tool-discovery overhead are not quantified.

## Mathematical contract

For OXP tokens `T`, surrounding tokens `S`, assumed surrounding output
fraction `o`, and cached-input fraction `c`:

- `effectiveInputRate = ((1-c)*input + c*cachedInput)*tierInputMultiplier`
- `effectiveOutputRate = output*tierOutputMultiplier`
- `oxpUSD = T*effectiveInputRate/1e6`
- `surroundingUSD = S*((1-o)*effectiveInputRate + o*effectiveOutputRate)/1e6`
- `combinedUSD = oxpUSD + surroundingUSD`

The baseline UI scenario is `o = 10%` and `c = 0%`, **explicitly an editable
assumption, not a trained output-ratio estimate**. A long-context scenario
uses 2× input/cache and 1.5× output when a **single request** exceeds 272K
input tokens; interval-wide aggregate token counts cannot infer that event.

No inferred API billing for cache writes, provider tool fees, Fast/Ultrafast
processing, regional uplift, or externally billed providers.

## Code and verification

- Calculation: `packages/app/src/pages/oxp/oxp-api-equivalent.ts`
- Presentation: `packages/app/src/pages/oxp/oxp-api-cost-panel.tsx`
- Integration: `packages/app/src/pages/oxp/oxp-attribution-panel.tsx`
- Verification: `bun test src/pages/oxp/oxp-api-equivalent.test.ts`
  from `packages/app` and `bun run typecheck` from the same directory.

This is a pure client-side projection of the existing server-owned attribution
snapshot; it creates no second telemetry source and performs no new API calls.
