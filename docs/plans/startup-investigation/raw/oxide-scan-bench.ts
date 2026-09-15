import { Scanner } from '@tailwindcss/oxide'
import path from 'node:path'
const root = process.cwd()
const sources = [
  ['packages/ui/src','**/*'],
  ['packages/app/src','**/*'],
  ['packages/session-ui/src','**/*'],
  ['packages/desktop/src','**/*'],
  ['packages/mobile/src','**/*'],
].map(([base,pattern]) => ({base:path.resolve(root,base),pattern,negated:false}))
for (let run=1; run<=3; run++) {
  const t0=performance.now()
  const scanner=new Scanner({sources})
  const t1=performance.now()
  const candidates=scanner.scan()
  const t2=performance.now()
  console.log(JSON.stringify({run,construct_ms:+(t1-t0).toFixed(2),scan_ms:+(t2-t1).toFixed(2),total_ms:+(t2-t0).toFixed(2),candidates:candidates.length,files:scanner.files.length,globs:scanner.globs.length}))
}
