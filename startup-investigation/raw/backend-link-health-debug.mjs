// STARTUP-AUTOPSY: one-shot health diagnostic against a freshly booted server.
import { performance } from "node:perf_hooks"
import { randomUUID } from "node:crypto"

const bundle = new URL("../../packages/opencode/dist/node/node.js", import.meta.url).href
const password = randomUUID()
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

const mod = await import(bundle)
const listener = await mod.Server.listen({
  port: 0,
  hostname: "127.0.0.1",
  username: "opencode",
  password,
  cors: ["oc://renderer"],
})
console.log("listening on", listener.port, "url", listener.url)

for (const path of ["/global/health", "/api/health"]) {
  for (const withAuth of [true, false]) {
    const t0 = performance.now()
    try {
      const res = await fetch(`http://127.0.0.1:${listener.port}${path}`, {
        headers: withAuth ? { authorization: auth } : {},
        signal: AbortSignal.timeout(3000),
      })
      const text = await res.text()
      console.log(JSON.stringify({ path, withAuth, status: res.status, ms: +(performance.now() - t0).toFixed(1), body: text.slice(0, 120) }))
    } catch (error) {
      console.log(JSON.stringify({ path, withAuth, error: String(error).slice(0, 160), ms: +(performance.now() - t0).toFixed(1) }))
    }
  }
}
await listener.stop(true)
process.exit(0)
