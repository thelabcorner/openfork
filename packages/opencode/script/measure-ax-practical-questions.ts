/**
 * Practical interrogative generalization probe written after the first AX
 * intent gate. Fixed qrels: do not rewrite them to flatter this candidate.
 */
import { CAPABILITY_DESCRIPTIONS } from "../src/oxp/prose"
import { SWARM_FOCUSED_ACTIONS } from "../src/oxp/swarm-focus"
import { rankCapabilities } from "../src/exchange/capability-search"
const catalog=Object.entries(CAPABILITY_DESCRIPTIONS).map(([id,description])=>({
 id,description,...(id==="openfork_swarm"?{focusActions:SWARM_FOCUSED_ACTIONS}:{})
}))
const cases: readonly (readonly [string,readonly string[]])[] = [
 ["What are my scheduled automations?",["schedule"]],
 ["What are the current recurring jobs in my workspace?",["schedule"]],
 ["What's the last commit in this repository?",["git"]],
 ["What is the current Git branch and uncommitted state?",["git"]],
 ["What are the new unstaged files in our worktree?",["git"]],
 ["What does my current Git diff contain?",["git"]],
 ["Why did this test in my repository fail?",["test"]],
 ["What's the result of the latest failing Vitest case?",["test"]],
 ["What is the outcome of my last typecheck?",["typecheck"]],
 ["Explain the errors in this TypeScript file",["typecheck","lsp"]],
 ["What are my active delegated worker sessions?",["openfork_worker"]],
 ["Which workers are currently blocked and waiting?",["openfork_worker"]],
 ["What did the previous engineering sessions decide?",["memory"]],
 ["What does the project SKILL.md say?",["skill"]],
 ["What's in this ZIP archive?",["archive"]],
 ["Describe the entries in this tarball",["archive"]],
 ["How do I rename the currently selected function safely?",["refactor"]],
 ["How do I list symbol references in the repository?",["symbols","lsp"]],
 ["Explain the SQLite query plan for this SELECT statement",["sqlite"]],
 ["What is the schema of the currently selected SQLite database?",["sqlite"]],
 ["What does my model token usage look like?",["usage"]],
 ["Describe these JSON objects and how they differ",["json"]],
 ["Summarize my last three Git commits",["git"]],
 ["What is the structure of the current monorepo?",["project"]],
 ["What are all the TODO comments in this source tree?",["find"]],
 ["What were the last errors printed by this running process?",["process"]],
 ["Explain the Python typecheck diagnostics in this report",["typecheck"]],
 ["What does the OXP browser tab display right now?",["browser"]],
]
let hit=0,mrr=0;const errors=[]
for (const [query,expected] of cases){
 const ids=rankCapabilities(catalog,query).map(({id})=>id)
 const index=ids.findIndex(id=>expected.includes(id))
 if(index>=0&&index<3)hit++
 if(index>=0)mrr+=1/(index+1)
 if(index<0||index>=3)errors.push({query,expected,first3:ids.slice(0,3),rank:index<0?null:index+1})
}
console.log(JSON.stringify({provenance:"source-authored post-gate practical interrogative probe; not blind",total:cases.length,recallAt3:hit/cases.length,mrr:mrr/cases.length,errors},null,2))
