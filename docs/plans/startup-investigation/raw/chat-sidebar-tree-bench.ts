import { performance } from 'node:perf_hooks'
import { buildChatSidebarSessionTreeRows } from '../../../../packages/app/src/pages/session/v2/chat-sidebar-session-tree.ts'
const roots = Array.from({ length: 2000 }, (_, i) => ({ id:`s${i}`, title:`s${i}`, directory:'C:/repo', projectID:'p', time:{created:i,updated:i} })) as any[]
const groups = Array.from({ length: 600 }, (_, g) => ({ id:`g${g}`, name:`g${g}`, position:g, kind:'user', sessions:Array.from({ length:12 }, (_, j) => ({ id:`s${(g*7+j*13)%roots.length}`, title:'', position:j, locked:false, origin:'user', timeAdded:j })), sessionIds:[], time:{created:1,updated:1} })) as any[]
for (let i=0;i<20;i++) buildChatSidebarSessionTreeRows({roots,groups,sessionByID:()=>undefined})
const samples=[]
for (let r=0;r<40;r++) { const t=performance.now(); for(let i=0;i<20;i++) buildChatSidebarSessionTreeRows({roots,groups,sessionByID:()=>undefined}); samples.push((performance.now()-t)/20) }
samples.sort((a,b)=>a-b)
console.log(JSON.stringify({median_ms:samples[Math.floor(samples.length/2)], p90_ms:samples[Math.floor(samples.length*.9)], min_ms:samples[0], max_ms:samples.at(-1)}))
