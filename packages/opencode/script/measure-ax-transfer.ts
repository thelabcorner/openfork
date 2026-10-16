/**
 * Exploratory out-of-fixture AX retrieval transfer probe. This is a separate
 * natural-language corpus authored after the ranker; NOT a clean random
 * holdout and NOT a model-task completion benchmark.
 *
 * Run from repository root:
 *   bun packages/opencode/script/measure-ax-transfer.ts
 */
import { CAPABILITY_DESCRIPTIONS } from "../src/oxp/prose"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"
import { rankCapabilities } from "../src/exchange/capability-search"

const catalog = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({
  id, description,
  ...(id === "openfork_swarm" ? { focusActions: SWARM_FOCUSED_ACTIONS } : {}),
}))

type Case = { readonly q: string; readonly expected: readonly string[] }
const queries: Case[] = [
  { q: "Where does this TypeScript function get called?", expected: ["symbols"] },
  { q: "Get the outline of a class and its methods", expected: ["symbols"] },
  { q: "My unit suite is failing", expected: ["test"] },
  { q: "Run TypeScript diagnostics", expected: ["typecheck"] },
  { q: "Create a markdown file", expected: ["write"] },
  { q: "Replace an exact text substring", expected: ["edit"] },
  { q: "Apply this unified diff to multiple files", expected: ["patch"] },
  { q: "What changed in git since yesterday?", expected: ["git"] },
  { q: "Tail the ongoing shell process output", expected: ["process"] },
  { q: "Show me the last two hundred lines of a file", expected: ["read"] },
  { q: "Locate TypeScript filenames using glob patterns", expected: ["find"] },
  { q: "Screenshot the currently open browser tab", expected: ["browser"] },
  { q: "Launch several parallel coding workers", expected: ["openfork_worker", "openfork_swarm"] },
  { q: "Send a message to the swarm team", expected: ["openfork_swarm"] },
  { q: "Find the largest context-window model", expected: ["models"] },
  // OXP's public models catalog explicitly says configured quota is host
  // private, and the current 33-capability catalog has no 'quota' operation.
  // Correct behavior is to abstain, not to hallucinate an executable tool.
  { q: "How much provider quota do I have left?", expected: [] },
  { q: "Set up a recurring job every morning", expected: ["schedule"] },
  { q: "Remind me every Monday", expected: ["schedule"] },
  { q: "Validate a JSONL stream", expected: ["json"] },
  { q: "Query nested JSON values", expected: ["json"] },
  { q: "Restore the last session checkpoint", expected: ["openfork_session.checkpoint"] },
  { q: "Identify the workspace build scripts and toolchain", expected: ["project"] },
  { q: "Recall prior engineering decisions", expected: ["memory"] },
  { q: "Transfer an uploaded project attachment", expected: ["file.transfer"] },
  // Explicit negatives: do not hallucinate a tool for unrelated topics.
  { q: "What is the tallest mountain on Mars?", expected: [] },
  { q: "Write a poem about a kitten", expected: [] },
  { q: "???", expected: [] },
  { q: "please help me", expected: [] },
]
function old(query: string) {
  const terms = query.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return catalog.filter((item) => terms.every((term) =>
    (item.id + " " + item.description).toLowerCase().replace(/[^a-z0-9]+/g, " ").includes(term),
  )).sort((a, b) => a.id.localeCompare(b.id)).map((item) => item.id)
}
function analyze(ranker: (query: string) => readonly string[]) {
  let rankAt3 = 0, mrr = 0, negativeCorrect = 0, positive = 0, totalResults = 0
  const cases = queries.map(({ q, expected }) => {
    const found = ranker(q)
    totalResults += found.length
    if (expected.length === 0) {
      if (found.length === 0) negativeCorrect++
      return { q, expected, first3: found.slice(0, 3), negativeCorrect: found.length === 0 }
    }
    positive++
    const i = found.findIndex((id) => expected.includes(id))
    if (i >= 0 && i < 3) rankAt3++
    if (i >= 0) mrr += 1 / (i + 1)
    return { q, expected, first3: found.slice(0, 3), rank: i < 0 ? null : i + 1 }
  })
  return {
    recallAt3: rankAt3 / positive,
    mrr: mrr / positive,
    negativeAccuracy: negativeCorrect / (queries.length - positive),
    meanReturnedItems: totalResults / queries.length,
    misses: cases.filter((row) => "rank" in row && (row.rank == null || (typeof row.rank === "number" && row.rank > 3))),
    falsePositives: cases.filter((row) => row.expected.length === 0 && row.first3.length > 0),
  }
}
const legacy = analyze(old)
const candidate = analyze((q) => rankCapabilities(catalog, q).map((item) => item.id))
console.log(JSON.stringify({
  provenance: "exploratory source-authored transfer probe; not blind human-labeled holdout or LLM execution",
  catalogSize: catalog.length,
  positiveQueries: queries.filter((q) => q.expected.length).length,
  negativeQueries: queries.filter((q) => !q.expected.length).length,
  legacy, candidate,
}, null, 2))
