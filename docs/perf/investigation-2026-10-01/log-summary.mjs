import fs from 'node:fs'
import path from 'node:path'
const root = process.argv[2]
const rows = []
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name < '20260924') continue
  const row = { run: entry.name, patterns: {} }
  for (const filename of ['main.log', 'renderer.log', 'renderer.old.log', 'server.log', 'server.old.log']) {
    const file = path.join(root, entry.name, filename)
    if (!fs.existsSync(file)) continue
    const text = fs.readFileSync(file, 'utf8')
    row.patterns[filename] = Object.fromEntries([
      ['errors', /\[error\]/g], ['warnings', /\[warn\]/g],
      ['bootstrapFailures', /Failed to finish bootstrap instance/g],
      ['instanceCreations', /creating instance/g], ['initComplete', /instance init complete/g],
      ['streamFailures', /event stream failed/g], ['streamEnded', /event stream ended/g],
      ['repairFailures', /stream repair failed/g], ['busyErrors', /SessionBusyError/g],
      ['sqlErrors', /SqlError/g], ['longTasks', /\[perf-longtask\]/g],
      ['serviceNameCollision', /Service name is already in use/g],
      ['logSuppression', /\[log-throttle\]/g],
    ].map(([key, re]) => [key, [...text.matchAll(re)].length]))
    if (filename === 'main.log') {
      const stamp = line => line?.match(/^\[([^\]]+)\]/)?.[1]
      const lines = text.split('\n')
      row.start = stamp(lines.find(l => l.includes('app starting')))
      row.ready = stamp(lines.find(l => /\sserver ready\s*\{/.test(l) && !l.includes('awaiting')))
      row.loaded = stamp(lines.find(l => l.includes('loading task finished')))
    }
  }
  rows.push(row)
}
console.log(JSON.stringify(rows, null, 2))
