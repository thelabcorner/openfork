/**
 * Reproducible AX schema footprint probe.
 *
 * Measures serialized JSON bytes, not tokenizer counts, prompt cost, latency,
 * or agent task success. This script is read-only and does not initialize an
 * OXP host, open a browser, spawn workers, or touch user project data.
 *
 * Run: bun packages/opencode/script/measure-ax-schema.ts
 */
import { Schema } from "effect"
import { OxpSchemaProjection as Projection } from "../src/oxp/schema-projection"
import { OxpBrowser } from "../src/oxp/browser"
import { OxpSwarm } from "../src/oxp/swarm"
import { OxpWorker } from "../src/oxp/worker"
import { OxpScheduleManagement } from "../src/oxp/schedule-management"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"

const fixtures = [
  { name: "browser", schema: OxpBrowser.Parameters, focusAction: "navigate" },
  { name: "openfork_swarm", schema: OxpSwarm.Parameters, focusAction: "task.batch" },
  { name: "openfork_worker", schema: OxpWorker.Parameters },
  { name: "schedule", schema: OxpScheduleManagement.Parameters, focusAction: "list" },
] as const

function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8")
}

function metrics(value: unknown) {
  return {
    bytes: size(value),
    descriptions: Projection.annotationCoverage(value).count,
  }
}

const data = fixtures.map((fixture) => {
  const definition = {
    schema: fixture.schema,
    ...(fixture.name === "openfork_swarm" ? { focusActions: SWARM_FOCUSED_ACTIONS } : {}),
  }
  const compact = Projection.definitionInputSchema(definition, "compact")
  const balanced = Projection.definitionInputSchema(definition, "balanced")
  const full = Projection.definitionInputSchema(definition, "full")
  const focusAction = "focusAction" in fixture ? fixture.focusAction : undefined
  const focus = focusAction
    ? Projection.focusedInputSchema(definition, focusAction, "balanced")
    : undefined
  const focusBytes = focus ? size(focus) : undefined
  return {
    capability: fixture.name,
    compact: metrics(compact),
    balanced: metrics(balanced),
    full: metrics(full),
    ...(focusBytes === undefined ? {} : {
      focused: {
        action: focusAction,
        ...metrics(focus),
        savingsPercent: +((1 - focusBytes / size(balanced)) * 100).toFixed(2),
      },
    }),
  }
})

// Decoder-backed guards: these are executable acceptance claims, not guesses
// from the shape of a JSON Schema projection.
const nullable = Schema.Struct({ value: Schema.NullOr(Schema.String) })
if (Schema.decodeUnknownSync(nullable)({ value: null }).value !== null)
  throw new Error("Runtime nullable-string precondition failed")
const nullableProjected = Projection.inputSchema(nullable)
const nullableNode = (nullableProjected as { properties?: Record<string, unknown> }).properties?.value
if (!JSON.stringify(nullableNode).includes('"type":"null"'))
  throw new Error("Projected schema lost a runtime-accepted null value")

const literal = Schema.Struct({ value: Schema.Union([Schema.Number, Schema.Literal("NaN")]) })
if (Schema.decodeUnknownSync(literal)({ value: "NaN" }).value !== "NaN")
  throw new Error("Runtime NaN-literal precondition failed")
const literalNode = (Projection.inputSchema(literal) as { properties?: Record<string, unknown> }).properties?.value
if (!JSON.stringify(literalNode).includes('"NaN"'))
  throw new Error("Projected schema lost a runtime-accepted NaN literal")

console.log(JSON.stringify({
  metric: "schema-json-utf8-bytes",
  context: "source-only on-demand descriptor projection, not permanent model prompt",
  executableNegativeGuards: ["required-nullable-string", "authored-NaN-literal"],
  data,
}, null, 2))
