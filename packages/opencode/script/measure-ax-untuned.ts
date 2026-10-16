/**
 * Untuned follow-up lexical transfer probe. Authored after the core retrieval
 * implementation and first development corpus were frozen. We do NOT tune the
 * ranker against these results; this is still a small source-authored set,
 * not a blind real-user sample or an LLM evaluation.
 */
import { CAPABILITY_DESCRIPTIONS } from "../src/oxp/prose"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"
import { rankCapabilities } from "../src/exchange/capability-search"

const catalog = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({
  id, description,
  ...(id === "openfork_swarm" ? { focusActions: SWARM_FOCUSED_ACTIONS } : {}),
}))

const tasks = [
  ["Find all callers of transformPath", ["symbols"]],
  ["Search for TODO comments across the repository", ["find"]],
  ["Which source files have uncommitted changes?", ["git"]],
  ["Walk me through the repo packages and scripts", ["project"]],
  ["Check which compiler diagnostics still exist", ["typecheck", "lsp"]],
  ["Rerun a broken Jest test suite", ["test"]],
  ["Apply this patch only when the original hunk matches", ["patch"]],
  ["Create a new TypeScript source file", ["write"]],
  ["Rename a function safely throughout the codebase", ["refactor"]],
  ["Capture a screenshot of the active browser page", ["browser"]],
  ["Create a recurring scheduled automation", ["schedule", "schedule.create"]],
  ["Recall historic engineering decisions from memory", ["memory"]],
  ["Send a progress message to another swarm member", ["openfork_swarm"]],
  ["Resume a blocked delegated worker", ["openfork_worker"]],
  ["Compare two JSON structures", ["json"]],
  ["Search models by their pricing and context window", ["models"]],
  ["Edit some existing source content", ["edit"]],
  ["Display installed Bun and Node runtime versions", ["project"]],
  ["Tell me the cash balance in my bank", []],
  ["Compose a song about an astronaut", []],
  ["Tell me a bedtime story", []],
  ["?!!?", []],
] as const

let hits = 0, reciprocal = 0, positives = 0, abstained = 0, negatives = 0
const cases = tasks.map(([q, expected]) => {
  const results = rankCapabilities(catalog, q).map((item) => item.id)
  if (expected.length === 0) {
    negatives++
    if (results.length === 0) abstained++
    return { query: q, expected, first3: results.slice(0, 3), correct: results.length === 0 }
  }
  positives++
  const i = results.findIndex((name) => (expected as readonly string[]).includes(name))
  if (i >= 0 && i < 3) hits++
  if (i >= 0) reciprocal += 1 / (i + 1)
  return { query: q, expected, first3: results.slice(0, 3), rank: i < 0 ? null : i + 1 }
})
console.log(JSON.stringify({
  provenance: "untuned source-authored follow-up corpus; no model, no blind real-user sampling",
  corpusSize: tasks.length,
  positiveQueries: positives,
  negativeQueries: negatives,
  recallAt3: hits / positives,
  mrr: reciprocal / positives,
  correctAbstention: abstained / negatives,
  misses: cases.filter((item) => "rank" in item && (item.rank == null || (typeof item.rank === "number" && item.rank > 3))),
  falsePositives: cases.filter((item) => "correct" in item && !item.correct),
}, null, 2))
