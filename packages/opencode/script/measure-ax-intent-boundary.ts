/**
 * AX intent-boundary challenge, frozen before the next retrieval revision.
 * Source-authored and not blinded/representative. Contrasts executable intent
 * with educational or creative mentions of the same tool vocabulary.
 * Do not change qrels to make a candidate ranker pass.
 */
import { CAPABILITY_DESCRIPTIONS } from "../src/oxp/prose"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"
import { rankCapabilities } from "../src/exchange/capability-search"
const catalog = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id,description])=>({
  id,description,...(id==="openfork_swarm"?{focusActions:SWARM_FOCUSED_ACTIONS}:{})
}))
type Case={query:string;acceptable:readonly string[]}
const positives:readonly Case[]=[
  {query:"Inspect git diff for modified files",acceptable:["git"]},
  {query:"Find the Git commit which first introduced this function",acceptable:["git"]},
  {query:"Show my unstaged source changes",acceptable:["git"]},
  {query:"Search usage sites of normalizeGroupBounds",acceptable:["symbols","lsp"]},
  {query:"Find the declaration of the makeContext method",acceptable:["symbols","lsp"]},
  {query:"Locate TODO annotations in packages/opencode",acceptable:["find"]},
  {query:"Search files named '*.test.ts' beneath src",acceptable:["find"]},
  {query:"Examine the final 50 lines of a log file",acceptable:["read"]},
  {query:"Read a README's contents",acceptable:["read"]},
  {query:"Create an entirely new README in the workspace",acceptable:["write"]},
  {query:"Overwrite the contents of a generated config file",acceptable:["write"]},
  {query:"Replace one string in an existing source file",acceptable:["edit"]},
  {query:"Apply a set of Git-format hunks atomically",acceptable:["patch"]},
  {query:"Decompress a tar.gz to an approved output folder",acceptable:["archive"]},
  {query:"Peek at the members in a compressed .zip file",acceptable:["archive"]},
  {query:"Read the journal_mode pragma from a SQLite DB",acceptable:["sqlite"]},
  {query:"Execute a SELECT query on my local SQLite database",acceptable:["sqlite"]},
  {query:"Compute a symbolic antiderivative of x cubed",acceptable:["sympy"]},
  {query:"Factor a polynomial with symbolic algebra",acceptable:["sympy"]},
  {query:"Run focused TypeScript compiler diagnostics",acceptable:["typecheck","lsp"]},
  {query:"Inspect editor language server diagnostics",acceptable:["lsp"]},
  {query:"Repeat a failing Vitest specification",acceptable:["test"]},
  {query:"Show project dependencies and package scripts",acceptable:["project"]},
  {query:"Print current Bun and Node toolchain versions",acceptable:["project"]},
  {query:"Open the browser and click the navigation button",acceptable:["browser"]},
  {query:"Capture a screenshot of a shared desktop tab",acceptable:["browser"]},
  {query:"Schedule an automation that runs every Monday",acceptable:["schedule","schedule.create"]},
  {query:"Find what my previous coding session decided",acceptable:["memory"]},
  {query:"Launch a supervised engineering worker for this task",acceptable:["openfork_worker"]},
  {query:"Delegate a batch of tasks to the agents in my swarm",acceptable:["openfork_swarm"]},
  {query:"Check public model prices and context size",acceptable:["models"]},
  {query:"Get the token count of my supervised session",acceptable:["usage"]},
  {query:"Read a local agent SKILL.md from this project",acceptable:["skill"]},
  {query:"Load an HTTP page through the approved network integration",acceptable:["web"]},
  {query:"Safely rename a function across all references",acceptable:["refactor"]},
  {query:"Download the attached ChatGPT file into an approved root",acceptable:["file.transfer"]},
  {query:"Run a shell script and capture stdout",acceptable:["process"]},
  {query:"List connected trusted OpenFork peers",acceptable:["ofxp"]},
  {query:"Validate a JSONC document and show parser errors",acceptable:["json"]},
  {query:"Restore an existing Session checkpoint",acceptable:["openfork_session.checkpoint"]},
]
const negatives:readonly Case[]=[
  {query:"Explain what a git diff is to someone learning version control",acceptable:[]},
  {query:"Explain the difference between Git merge and rebase",acceptable:[]},
  {query:"Write a funny story where a programmer uses Git",acceptable:[]},
  {query:"Write a poem about a rusty process running in a terminal",acceptable:[]},
  {query:"What are the benefits of writing unit tests?",acceptable:[]},
  {query:"Explain test-driven development in plain English",acceptable:[]},
  {query:"What does a TypeScript compiler actually do?",acceptable:[]},
  {query:"Explain what a language server does for programmers",acceptable:[]},
  {query:"How do browsers render CSS layouts conceptually?",acceptable:[]},
  {query:"Teach me why click handlers are used in a browser",acceptable:[]},
  {query:"Summarize the history of SQLite databases",acceptable:[]},
  {query:"What does WAL stand for in SQLite?",acceptable:[]},
  {query:"Explain the ZIP compression format",acceptable:[]},
  {query:"A children's story about extracting treasure from an archive",acceptable:[]},
  {query:"What is symbolic mathematics?",acceptable:[]},
  {query:"Explain how polynomial derivatives work",acceptable:[]},
  {query:"What is agent orchestration in AI?",acceptable:[]},
  {query:"What does an AI worker agent mean?",acceptable:[]},
  {query:"Describe model context windows for beginners",acceptable:[]},
  {query:"Compare mental models of human memory",acceptable:[]},
  {query:"Explain differences between YAML and JSON",acceptable:[]},
  {query:"Write a paragraph describing a read-only document",acceptable:[]},
  {query:"What is the purpose of an HTTP URL?",acceptable:[]},
  {query:"Explain how periodic scheduled jobs work",acceptable:[]},
  {query:"What is a computer project and its folder structure?",acceptable:[]},
  {query:"Compose a motivational speech for a development team",acceptable:[]},
  {query:"Please tell me a story about a worker who finds files",acceptable:[]},
  {query:"Which programming language is best for beginners?",acceptable:[]},
  {query:"I am stressed and need someone to listen",acceptable:[]},
  {query:"Look up my personal bank card balance",acceptable:[]},
  {query:"Get my provider subscription quota right now",acceptable:[]},
  {query:"Render a picture of a green cartoon fox",acceptable:[]},
]
const cases=[...positives,...negatives]
let hits=0,mrr=0,abstentions=0,candidates=0
const results=cases.map(({query,acceptable})=>{
 const ranked=rankCapabilities(catalog,query).map((x)=>x.id)
 const rank=acceptable.length?ranked.findIndex(x=>acceptable.includes(x))+1:0
 const correct=acceptable.length?rank>0&&rank<=3:ranked.length===0
 if(acceptable.length){if(correct)hits++;if(rank>0)mrr+=1/rank}
 else if(correct)abstentions++
 candidates+=ranked.length
 return {query,acceptable,first3:ranked.slice(0,3),rank:rank||null,correct}
})
console.log(JSON.stringify({
 provenance:"Source-authored intent-boundary contrast set; no held-out real user sampling",
 positive:positives.length,negative:negatives.length,
 recallAt3:hits/positives.length,mrr:mrr/positives.length,
 abstention:abstentions/negatives.length,meanCandidates:candidates/cases.length,
 errors:results.filter(x=>!x.correct),
},null,2))
