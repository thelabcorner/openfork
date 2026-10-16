/**
 * Metamorphic paraphrase challenge. Frozen seeds and transformations before
 * handling politeness/honorific wrapping. Synthetic, not a real-user holdout.
 */
import { CAPABILITY_DESCRIPTIONS } from "../src/oxp/prose"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"
import { rankCapabilities } from "../src/exchange/capability-search"
const catalog=Object.entries(CAPABILITY_DESCRIPTIONS).map(([id,description])=>({
  id,description,...(id==="openfork_swarm"?{focusActions:SWARM_FOCUSED_ACTIONS}:{})
}))
const positives:readonly (readonly [string,readonly string[]])[]=[
  ["Check my current Git diff",["git"]],
  ["List the active supervised workers",["openfork_worker"]],
  ["Find the source files containing TODO comments",["find"]],
  ["Show me the README file contents",["read"]],
  ["Search symbol references for normalizeBounds",["symbols"]],
  ["Run a focused typecheck on this project",["typecheck"]],
  ["Inspect the ZIP archive entries",["archive"]],
  ["Check my current model usage tokens",["usage"]],
  ["Restore my selected session checkpoint",["openfork_session.checkpoint"]],
  ["Describe the entries in this tarball",["archive"]],
  ["Explain these compiler diagnostics",["typecheck","lsp"]],
  ["What are my latest scheduled automations?",["schedule"]],
]
const negatives:readonly string[]=[
  "Explain what a Git commit is",
  "What does WAL stand for in SQLite?",
  "Describe what symbolic integration means",
  "Explain the ZIP file format",
  "Explain the benefits of unit testing",
  "How do browsers render CSS?",
  "What is the purpose of a shell?",
  "Teach me how an AI worker functions",
  "Compare Git merge and rebase conceptually",
  "Summarize the history of TypeScript",
  "What is a model context window?",
  "Describe what project structure means",
]
const wrappers=[
  (q:string)=>q,
  (q:string)=>"Please "+q[0]!.toLowerCase()+q.slice(1),
  (q:string)=>"Could you "+q[0]!.toLowerCase()+q.slice(1),
  (q:string)=>"I'd like you to "+q[0]!.toLowerCase()+q.slice(1),
  (q:string)=>"If possible, "+q[0]!.toLowerCase()+q.slice(1),
  (q:string)=>q.toUpperCase(),
]
let answer=0,hit=0,negative=0,abstained=0
const errors:Array<{q:string;expected:readonly string[];results:string[]}>=[]
for(const wrap of wrappers){
 for(const [base,expected] of positives){
  answer++;const q=wrap(base),results=rankCapabilities(catalog,q).map(x=>x.id)
  if(results.slice(0,3).some(x=>expected.includes(x)))hit++
  else errors.push({q,expected,results:results.slice(0,3)})
 }
 for(const base of negatives){
  negative++;const q=wrap(base),results=rankCapabilities(catalog,q).map(x=>x.id)
  if(!results.length)abstained++
  else errors.push({q,expected:[],results:results.slice(0,3)})
 }
}
console.log(JSON.stringify({
 provenance:"synthetic paraphrase metamorphic development challenge; not real-user holdout",
 positive:answer,negative,recallAt3:hit/answer,abstention:abstained/negative,
 errors:errors.slice(0,50),errorCount:errors.length
},null,2))
