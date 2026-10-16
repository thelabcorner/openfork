import { SqliteBunWorkerClient } from "../../src/database/sqlite-bun-worker-client"

const filename = process.argv[2]
const clientID = Number(process.argv[3])
if (!filename || !Number.isInteger(clientID)) throw new Error("Missing database filename or peer ID")
const client = new SqliteBunWorkerClient({ filename, disableWAL: true, checkpointOnClose: false })
let attempts = 0
try {
  await client.ready
  await client.request({ kind: "query", query: "PRAGMA busy_timeout = 20", params: [], arrays: false, safeIntegers: false })
  for (let sequence = 0; sequence < 20; sequence++) {
    const deadline = performance.now() + 15_000
    for (;;) {
      attempts++
      try {
        await client.request({
          kind: "query",
          query: "INSERT INTO peer_writes(id) VALUES (?)",
          params: [clientID * 1000 + sequence],
          arrays: false,
          safeIntegers: false,
        })
        break
      } catch (cause) {
        const code = (cause as { code?: string }).code
        if (code !== "SQLITE_BUSY" || performance.now() >= deadline) throw cause
        await Bun.sleep(3 + Math.floor(Math.random() * 8))
      }
    }
  }
  console.log(JSON.stringify({ clientID, inserted: 20, attempts }))
} finally {
  await client.close()
}