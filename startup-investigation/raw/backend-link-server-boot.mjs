// STARTUP-AUTOPSY: backend-link lane harness (temporary, not committed).
// Reproduces the desktop sidecar boot path WITHOUT Electron:
//   import dist/node/node.js  ->  Server.listen(...)  ->  first successful health GET
// Mirrors packages/desktop/src/main/sidecar.ts start() and server.ts checkHealth().
// Usage:
//   node startup-investigation/raw/backend-link-server-boot.mjs            (WARM xN)
//   node --cpu-prof --cpu-prof-dir startup-investigation/raw --cpu-prof-name backend-link-boot.cpuprofile startup-investigation/raw/backend-link-server-boot.mjs
import { performance } from "node:perf_hooks"
import { randomUUID } from "node:crypto"

const bundle = new URL("../../packages/opencode/dist/node/node.js", import.meta.url).href
const password = randomUUID()
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

// Mirror sidecar.ts prepareSidecarEnv: the server reads credentials from env at
// layer build (ServerAuth.Config), so they must be set BEFORE importing the
// bundle — ambient OPENCODE_SERVER_PASSWORD from the host session would
// otherwise override the per-launch random password.
process.env.OPENCODE_SERVER_USERNAME = "opencode"
process.env.OPENCODE_SERVER_PASSWORD = password

const t0 = performance.now()
const mod = await import(bundle)
const tImport = performance.now()

const listener = await mod.Server.listen({
  port: 0, // same as desktop: prefers 4096, falls back to ephemeral
  hostname: "127.0.0.1",
  username: "opencode",
  password,
  cors: ["oc://renderer"],
})
const tListen = performance.now()

async function checkHealth() {
  for (const path of ["/api/health", "/global/health"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${listener.port}${path}`, {
        headers: { authorization: auth },
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return path
    } catch {}
  }
  return null
}

let tHealth = null
let healthPath = null
const deadline = performance.now() + 60_000
while (performance.now() < deadline) {
  await new Promise((r) => setTimeout(r, 25)) // desktop polls at 100ms; finer here for attribution
  const ok = await checkHealth()
  if (ok) {
    tHealth = performance.now()
    healthPath = ok
    break
  }
}

// second request on the warm server: pure request-handling cost, no boot
const t2a = performance.now()
const ok2 = await checkHealth()
const t2b = performance.now()

console.log(
  JSON.stringify({
    port: listener.port,
    import_ms: +(tImport - t0).toFixed(1),
    listen_ms: +(tListen - tImport).toFixed(1),
    first_health_ms: tHealth === null ? null : +(tHealth - tListen).toFixed(1),
    total_spawn_to_health_ms: tHealth === null ? null : +(tHealth - t0).toFixed(1),
    warm_health_req_ms: ok2 ? +(t2b - t2a).toFixed(1) : null,
    health_path: healthPath,
    node: process.version,
  }),
)
await listener.stop(true)
process.exit(0)
