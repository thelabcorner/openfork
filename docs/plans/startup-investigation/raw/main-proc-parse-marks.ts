// STARTUP-AUTOPSY: parses [STARTUP-AUTOPSY] marks from a harness trial log into a
// phase table (lane main-proc). Usage: bun parse-marks.ts <log-path>
const path = process.argv[2]
if (!path) {
  console.error("usage: bun parse-marks.ts <log>")
  process.exit(1)
}
const text = await Bun.file(path).text()
const rows = []
for (const line of text.split("\n")) {
  const i = line.indexOf("[STARTUP-AUTOPSY]")
  if (i < 0) continue
  const json = line.slice(i + "[STARTUP-AUTOPSY]".length).trim()
  try {
    rows.push({ stamp: line.slice(0, i).trim(), ...JSON.parse(json) })
  } catch {}
}
// group by pid; keep insertion order per pid
const byPid = new Map()
for (const r of rows) {
  if (!byPid.has(r.pid)) byPid.set(r.pid, [])
  byPid.get(r.pid).push(r)
}
for (const [pid, rs] of byPid) {
  console.log(`\n=== pid ${pid} (${rs.length} marks) ===`)
  let prev = null
  for (const r of rs) {
    const delta = prev === null ? "" : ` (+${Math.round((r.ms - prev) * 100) / 100})`
    console.log(`${String(r.ms).padStart(10)} ms${delta.padStart(10)}  ${r.mark}`)
    prev = r.ms
  }
}
