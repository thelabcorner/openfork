(async () => {
  const wc = require('electron').webContents.getAllWebContents().find(w => w.getType() === 'window')
  return await wc.executeJavaScript(`(async () => {
    const connection = await window.api.awaitInitialization()
    const headers = connection.password ? { authorization: 'Basic ' + btoa((connection.username || 'opencode') + ':' + connection.password) } : {}
    const results = []
    for (let round = 0; round < 3; round++) {
      for (const path of ['/global/health', '/instance/identity', '/global/preferences']) {
        const start = performance.now()
        try {
          const response = await fetch(new URL(path, connection.url), { headers, signal: AbortSignal.timeout(5000) })
          await response.arrayBuffer()
          results.push({ round, path, status: response.status, ms: performance.now() - start })
        } catch (error) {
          results.push({ round, path, error: error.name, ms: performance.now() - start })
        }
      }
    }
    return { at: new Date().toISOString(), origin: new URL(connection.url).origin, results }
  })()`)
})()
