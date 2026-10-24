(() => {
  const fs = require('node:fs')
  const path = require('node:path')
  const root = require('electron').app.getAppPath()
  const requests = [
    { file: 'out/renderer/assets/app-shell-ViGnKAPH.js', marker: 'agent-list-legacy', before: 1400, after: 350 },
    { file: 'out/renderer/assets/app-shell-ViGnKAPH.js', marker: 'stream repair failed', before: 900, after: 700 },
    { file: 'out/renderer/assets/app-shell-ViGnKAPH.js', marker: 'const queueRemoteInterest =', before: 0, after: 4200 },
    { file: 'out/renderer/assets/app-shell-ViGnKAPH.js', marker: 'function streamInterestUpdatePriority', before: 0, after: 350 },
    { file: 'out/renderer/assets/session-DsRUWFaT.js', marker: 'repairStreamContent', before: 700, after: 1000 },
    { file: 'out/main/chunks/node-Cqf3gWVv.js', marker: 'function buildLocationServiceMap', before: 0, after: 3000 },
  ]
  return JSON.stringify(requests.map(item => {
    const source = fs.readFileSync(path.join(root, item.file), 'utf8')
    const offset = source.indexOf(item.marker)
    return { file: item.file, marker: item.marker, offset,
      excerpt: offset < 0 ? null : source.slice(Math.max(0, offset - item.before), offset + item.after) }
  }), null, 2)
})()
