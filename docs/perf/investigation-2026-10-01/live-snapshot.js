(async () => {
  const { webContents, app } = require('electron')
  const wc = webContents.getAllWebContents().find(w => w.getType() === 'window')
  if (!wc) return { error: 'No window' }
  const page = await wc.executeJavaScript(`(() => {
    const animations = document.getAnimations()
    const kinds = {}
    for (const a of animations) {
      const key = a.animationName || a.constructor.name
      kinds[key] = (kinds[key] || 0) + 1
    }
    return {
      visibility: document.visibilityState,
      elements: document.getElementsByTagName('*').length,
      animations: animations.length, animationKinds: kinds,
      spinners: document.querySelectorAll('[data-component="spinner"]').length,
      sidebarRows: document.querySelectorAll('[data-chat-tooltip-session]').length,
      timelineRows: document.querySelectorAll('[data-timeline-row]').length,
      phaseTrace: typeof window.__opencodePhaseTrace === 'function' ? window.__opencodePhaseTrace() : null,
      perfGlobals: Object.keys(window).filter(k => /^__.*(perf|trace|scheduler|startup)/i.test(k)),
      startup: window.__opencodeStartupPerf?.(),
      requests: window.__opencodeServerRequestQoS?.(),
      streams: window.__opencodeServerStreamQoS?.(),
      resources: performance.getEntriesByType('resource').filter(r => /127\\.0\\.0\\.1/.test(r.name)).map(r => {
        const u = new URL(r.name)
        return { path: u.pathname.replace(/ses_[^/]+/g, ':session').replace(/msg_[^/]+/g, ':message'), start: r.startTime, duration: r.duration, ttfb: r.responseStart > 0 ? r.responseStart - r.startTime : null, bytes: r.transferSize }
      })
    }
  })()`)
  return JSON.stringify({ at: new Date().toISOString(), version: app.getVersion(), packaged: app.isPackaged,
    pid: process.pid, rendererPid: wc.getOSProcessId(), page }, null, 2)
})()
