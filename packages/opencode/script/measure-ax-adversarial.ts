/**
 * AX challenge probe: source-authored BEFORE the next capability ranking changes.
 * This probes broader language, distractors, unsupported tasks and multi-tool
 * ambiguity. Once inspected, it is DEVELOPMENT data, not a blinded holdout.
 * Do not rewrite labels to match model output.
 */
import { CAPABILITY_DESCRIPTIONS } from "../src/oxp/prose"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"
import { rankCapabilities } from "../src/exchange/capability-search"

const catalog = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({
  id, description,
  ...(id === "openfork_swarm" ? { focusActions: SWARM_FOCUSED_ACTIONS } : {}),
}))
type Case = { query: string; expected: readonly string[] }
const cases: readonly Case[] = [
  { query: "Where are references to normalizeBounds?", expected: ["symbols", "lsp"] },
  { query: "Show me implementations of the computeBezier function", expected: ["symbols"] },
  { query: "Who invokes the drawFrame method elsewhere?", expected: ["symbols"] },
  { query: "Search the source for FIXME annotations", expected: ["find"] },
  { query: "Locate any TODO markers under packages", expected: ["find"] },
  { query: "Which files were modified in my working tree but not staged?", expected: ["git"] },
  { query: "List the commits since last release", expected: ["git"] },
  { query: "What are the outstanding changes in this checkout?", expected: ["git"] },
  { query: "Show an overview of all workspaces in this monorepo", expected: ["project"] },
  { query: "Which package scripts can I invoke for this repository?", expected: ["project"] },
  { query: "Give me the directory layout and dependency stack", expected: ["project"] },
  { query: "Safely rename this variable without touching unrelated names", expected: ["refactor"] },
  { query: "Move this TypeScript symbol to a new name consistently", expected: ["refactor"] },
  { query: "Check all type errors in the compiler", expected: ["typecheck"] },
  { query: "What errors does the language server report for this file?", expected: ["lsp", "typecheck"] },
  { query: "Run the failing AVA suite", expected: ["test"] },
  { query: "Repeat only a single failing test case", expected: ["test"] },
  { query: "Inspect the last 50 lines of a configuration file", expected: ["read"] },
  { query: "Show the first lines of the README", expected: ["read"] },
  { query: "Replace one exact token in an existing file", expected: ["edit"] },
  { query: "Generate a new README file inside this repo", expected: ["write"] },
  { query: "Apply a unified diff with conflict detection", expected: ["patch"] },
  { query: "Unpack this tarball to an approved directory", expected: ["archive"] },
  { query: "List zip entries without unpacking anything", expected: ["archive"] },
  { query: "Inspect the WAL mode for this SQLite database", expected: ["sqlite"] },
  { query: "Run a SELECT statement against the SQLite file", expected: ["sqlite"] },
  { query: "Differentiate this polynomial symbolically", expected: ["sympy"] },
  { query: "Parse and compare two JSONL logs", expected: ["json"] },
  { query: "Check the model with the lowest price and largest context", expected: ["models"] },
  { query: "Read the number of tokens spent by that supervised session", expected: ["usage"] },
  { query: "Recall decisions made by previous coding agents", expected: ["memory"] },
  { query: "Load a local agent SKILL.md", expected: ["skill"] },
  { query: "Launch an agent to investigate independently", expected: ["openfork_worker"] },
  { query: "Assign work to several swarm members", expected: ["openfork_swarm"] },
  { query: "Restore an earlier saved checkpoint for my session", expected: ["openfork_session.checkpoint"] },
  { query: "Open a web page and click the submit element", expected: ["browser"] },
  { query: "Search the internet for project documentation", expected: ["web"] },
  { query: "Schedule a weekly reminder and show me recent runs", expected: ["schedule"] },
  { query: "Show currently running shell commands and their logs", expected: ["process"] },
  { query: "Export a screenshot from a shared browser tab", expected: ["browser"] },
  { query: "Connect to a trusted OpenFork peer", expected: ["ofxp"] },
  { query: "Upload the attached file into the workspace", expected: ["file.transfer"] },
  { query: "Tell me a funny story about turtles", expected: [] },
  { query: "Suggest 5 baby names", expected: [] },
  { query: "Create a fictional character biography", expected: [] },
  { query: "Give me a motivational quote", expected: [] },
  { query: "Explain the history of Roman architecture", expected: [] },
  { query: "Can you help me please?", expected: [] },
  { query: "asdfghjk qwertyuiop", expected: [] },
  { query: "My Experian credit score this morning", expected: [] },
  { query: "Check my bank deposits today", expected: [] },
  { query: "What's the weather in Tokyo this evening?", expected: [] },
  { query: "Make me a portrait of a robot", expected: [] },
  { query: "Calculate my retirement savings needed", expected: [] },
]
let hit = 0, mrr = 0, answers = 0, abstain = 0, negatives = 0, candidateCount=0
const details=cases.map(({query,expected})=>{
  const results=rankCapabilities(catalog,query).map(({id})=>id)
  candidateCount+=results.length
  const rank=expected.length?results.findIndex((id)=>expected.includes(id))+1:0
  if(expected.length){
    answers++
    if(rank>0&&rank<=3)hit++
    if(rank>0)mrr+=1/rank
  } else {
    negatives++
    if(!results.length)abstain++
  }
  return {query, expected, first3:results.slice(0,3),rank:rank||null,correct:expected.length?rank>0&&rank<=3:!results.length}
})
console.log(JSON.stringify({
  provenance:"Source-authored prospective AX challenge, no blinded sampling, no LLM tasks",
  total:cases.length,answers,negatives,recallAt3:hit/answers,mrr:mrr/answers,
  correctAbstention:abstain/negatives,meanCandidates:candidateCount/cases.length,
  misses:details.filter((x)=>!x.correct),
},null,2))
