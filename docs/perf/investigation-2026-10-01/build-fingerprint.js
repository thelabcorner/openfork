(() => {
  const fs = require('node:fs')
  const path = require('node:path')
  const crypto = require('node:crypto')
  const app = require('electron').app
  const root = app.getAppPath()
  const markers = ['agent-list-legacy', 'stream repair failed', 'repairStreamContent', 'dense-working-indicator', 'does not spend the critical reserve', 'booting location services', 'SessionProcessor', 'instance init complete']
  const files = []
  for (const folder of ['out/main/chunks', 'out/renderer/assets']) {
    const directory = path.join(root, folder)
    if (!fs.existsSync(directory)) continue
    for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.js')) continue
      const file = path.join(directory, name)
      const bytes = fs.readFileSync(file)
      const source = bytes.toString('utf8')
      const found = markers.filter(marker => source.includes(marker))
      if (!found.length && bytes.length < 500000) continue
      files.push({ path: folder + '/' + name, bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'), markers: found })
    }
  }
  return JSON.stringify({ at: new Date().toISOString(), pid: process.pid,
    version: app.getVersion(), packaged: app.isPackaged, appPath: root, files }, null, 2)
})()
