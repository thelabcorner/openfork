# OXP Token-Accounting Boundary Specification

**Status:** canonical source-of-truth for the observable OXP accounting unit
**Owner:** `packages/opencode/src/oxp/context-footprint.ts` (producer),
`packages/core/src/oxp-activity` (durable scalar storage),
`packages/core/src/oxp-attribution` (estimator)
**Related:** `docs/plans/oxp-token-usage-estimation-rebuild.md`

This document defines exactly what OXP measures at its boundary, in which unit,
and how that respects the two-layer estimation model. It is the reference that
the payload calibration (`payload-calibration-v1.json`) and the upstream usage
profile (`calibration-v2.json`) must stay consistent with.

## 1. The observable accounting unit

An OXP invocation is a **request/response boundary**, not a timeline of model
context residency. For invocation `i` the estimator consumes two scalars:

| Scalar | Producer | Meaning |
| --- | --- | --- |
| `context_request_chars` | `requestContextChars(args)` | Unicode-code-point length of the JSON serialization of the tool arguments. |
| `context_result_chars` | `resultContextChars(result)` | Summed Unicode-code-point length of **text** items in the MCP `CallToolResult.content`. |

`T_OXP = Σ_i (T̂_request,i + T̂_result,i)` counts each observed invocation
**once**. There is no multiplier, no carry-forward, and no repeated-context
assumption.

## 2. Request measurement

- Source: the final `args` value passed to the MCP tool handler (`BeginInput.args`).
- Representation: `JSON.stringify(args)`, then `codePointLength(...)`.
- `undefined` (non-serializable args) contributes `0`; a `JSON.stringify`
  throw yields `undefined` and the scalar is not persisted (`unavailable`).
- The measurement is **transient**: arguments are serialized only to measure
  their textual footprint and are never persisted by this path.
- It corresponds to user/model-authored tool arguments as delivered at the OXP
  boundary, **after** any envelope/transport unwrapping performed by the OXP
  server. Hidden transport envelope fields are not part of `args` and are not
  counted.

## 3. Result measurement

- Source: the MCP `CallToolResult` returned by the handler after all server-side
  augmentation (including continuity notices).
- Representation: for each `content` item with `type === "text"` and a string
  `text`, add `codePointLength(item.text)`. Non-text items (image, audio,
  resource, structured content) contribute **zero**; they are not converted into
  pretend text tokens.
- The result scalar is what is subsequently visible to the model as text. It is
  not the structured result object and not the retained full tool output
  (`session_tool_output`); those are separate, larger representations.
- `source: "observed_boundary"` is written on settle only when
  `resultContextChars` is supplied. Failures pass the error's own boundary text
  through the same function.

## 4. Unit and tokenizer calibration

- Unit is **Unicode code points**, not UTF-16 code units and not UTF-8 bytes.
  `codePointLength` counts surrogate pairs as one, matching SQLite
  `length(TEXT)`, so live boundary scalars and historical
  `oxp-primary-args-output-error/v1` detail share one calibration.
- The chars-per-token ratios are measured by deterministic tokenization of
  historical tool payloads under `o200k_base` (see
  `payload-calibration-v1.json.tokenizer`).
- This is an **estimate**: ChatGPT's server-side tokenization may differ. The
  estimator is a calibrated local text-to-token proxy, not billing truth.

## 5. Status and non-applicable results

`OxpAttributionStatusPolicy.responseExpectation` classifies each terminal status:

- `success, committed, failed, conflict, denied, cancelled_before_commit,
  cancelled_after_commit` → a result is expected.
- `interrupted, running` → no result is expected (`not_applicable`).
- anything else → `undefined`, recorded as `unavailable`; donor fallback is
  **not** applied because response semantics are unknown.

A missing expected result is imputed from the tool/status donor statistics
(`calibrated_donor`) only when a donor population exists.

## 6. Provenance / coverage vocabulary

Each request and result scalar carries a `source`:

| Source | Meaning |
| --- | --- |
| `observed_boundary` | Recorded directly at the OXP boundary (`oxp-boundary-primary-text/v1`). |
| `historical_detail` | Derived from retained historical detail (`oxp-primary-args-output-error/v1`). |
| `calibrated_donor` | Imputed from comparable tool/status rows in the payload calibration. |
| `unavailable` | No responsible estimate. |

Request and result coverage are reported separately. `complete` is true only when
both lanes have zero `unavailable` rows and there are no
`invalidPersistedMeasurements`. **A complete snapshot does not imply every row was
directly observed** — donor-imputed rows remain complete but are labelled.

## 7. Envelope and legacy-canonical alignment

- Live boundary scalars use schema `oxp-boundary-primary-text/v1`.
- Legacy backfilled scalars use `oxp-primary-args-output-error/v1`
  (`length(json_extract(request,'$.args'))` and summed `output` + `error`
  lengths) and are gated to rows at or before the calibration corpus window
  (`payload.corpus.maxStartedAt`). Newer rows are never reinterpreted as the old
  canonical population; a missing newer measurement stays estimated/unavailable.

## 8. What OXP does not observe

OWP does not claim to observe: ChatGPT's full server-side prompt; the model's
exact tokenizer; whether a result remains resident in future context; how many
times prior OXP text was reprocessed; prompt-cache internals; semantic memory
retention; or the exact causal contribution of OXP to all model tokens.
The upstream/surrounding estimate (`calibration-v2.json`) is a separate,
empirically learned **association**, not a causal or residency quantity.
