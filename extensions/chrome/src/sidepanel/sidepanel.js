// sidepanel.js — MV3 side_panel for "opencode for Chrome".
// Shows extension ID, ping/reconnect for the native host bridge.

const $ = (sel) => document.querySelector(sel)

function setBadge(text, tone) {
  const el = $("#status-badge")
  if (!el) return
  el.textContent = text
  el.className = tone === "ok" ? "badge ok" : tone === "warn" ? "badge warn" : "badge"
}

function setDetail(text) {
  const el = $("#status-detail")
  if (el) el.textContent = text
}

async function refresh() {
  // Extension ID
  try {
    const id = chrome?.runtime?.id ?? "—"
    const extIdEl = $("#ext-id")
    if (extIdEl) extIdEl.textContent = `extension id: ${id}`
  } catch {}

  // Probe background via runtime message
  try {
    const res = await chrome.runtime.sendMessage({ type: "opencode:ping" })
    if (res?.pong) {
      setBadge("connected", "ok")
      setDetail(`pong from background — ${res.version ?? chrome.runtime.getManifest().version} — id ${res.extensionId ?? chrome.runtime.id}`)
      const hint = $("#status-hint")
      if (hint) hint.textContent = "Background service worker is alive."
    } else {
      setBadge("unknown", "warn")
      setDetail(JSON.stringify(res ?? null).slice(0, 400))
    }
  } catch (e) {
    setBadge("not connected", "warn")
    setDetail(String(e?.message ?? e))
    const hint = $("#status-hint")
    if (hint) hint.textContent = "Is the desktop app running? Try Reconnect."
  }
}

document.getElementById("btn-ping")?.addEventListener("click", () => {
  void refresh()
})

document.getElementById("btn-reconnect")?.addEventListener("click", async () => {
  setBadge("reconnecting…", "warn")
  setDetail("sending reconnect…")
  try {
    // Ask SW to reconnect native port (it does lazy connect on next op anyway)
    await chrome.runtime.sendMessage({ type: "opencode:ping" })
  } catch {}
  setTimeout(() => void refresh(), 600)
})

// Initial load
void refresh()
// Poll lightly — SW may go idle
setInterval(() => void refresh(), 10000)
