import fs from "node:fs/promises"
import path from "node:path"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"

const xdg = await import("xdg-basedir")
const expectedConfig = process.env.XDG_CONFIG_HOME
if (!expectedConfig || path.resolve(xdg.xdgConfig!) !== path.resolve(expectedConfig)) {
  throw new Error("Test-only OXP host process was not isolated from the real user configuration")
}
const testRoot = process.env.OXP_LAZY_FIXTURE_ROOT
if (!testRoot) throw new Error("Missing disposable test root")

const started = performance.now()
const { OxpHost } = await import("../../src/oxp/host")
const state = await OxpHost.getState()
if (state.enabled || state.endpoint.state !== "stopped") throw new Error("Fresh isolated OXP host was not disabled")
await fs.mkdir(testRoot, { recursive: true })
await fs.writeFile(path.join(testRoot, "tiny.txt"), "hello from isolated lazy host\n")
const approved = await OxpHost.approveRoot(testRoot, "lazyfixture")
const rootID = approved.roots.find((root) => root.alias === "lazyfixture")?.id
if (!rootID) throw new Error("Disposable approved root missing from OXP host state")
if (process.env.OXP_TEST_CATALOG_FIRST === "1") {
  console.log("OXP_CATALOG_STAGE", "disabled-check")
  let denied = false
  try {
    await OxpHost.listWorkerAgents(rootID)
  } catch (error) {
    denied = (error as { readonly _tag?: string })._tag === "OXP_AUTH_DENIED"
  }
  if (!denied) throw new Error("Disabled OXP unexpectedly loaded the worker catalog")
}
await OxpHost.setGrant({ read: true })
const enabled = await OxpHost.setEnabled(true)
if (!enabled.endpoint.url || enabled.endpoint.state !== "ready") throw new Error("Lean OXP endpoint failed to start")
const atReady = performance.now()
console.log("OXP_READY", JSON.stringify({
  ms: Math.round(atReady - started),
  heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
}))
if (process.env.OXP_TEST_CATALOG_FIRST === "1") {
  console.log("OXP_CATALOG_STAGE", "enabled-loading")
  const catalog = await OxpHost.listWorkerAgents(rootID)
  if (catalog.rootID !== rootID || !Array.isArray(catalog.agents)) {
    throw new Error("Enabled lazy host did not load the authorized worker agent catalog")
  }
  console.log("OXP_CATALOG", JSON.stringify({ listed: true, agents: catalog.agents.length }))
}
const client = new Client(
  { name: "oxp-host-lazy-fixture", version: "1.0.0" },
  { versionNegotiation: { mode: { pin: "2026-07-28" } } },
)
let verified = false
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(enabled.endpoint.url)))
  const listed = await client.listTools()
  if (listed.tools.length !== 14) throw new Error("Static transport manifest missing tools")
  console.log("OXP_LIST", JSON.stringify({
    ms: Math.round(performance.now() - started),
    heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
    count: listed.tools.length,
  }))
  if (process.env.OXP_TEST_RACE_STOP === "1") {
    // The request may win admission or lose it to stop; either outcome is
    // correct, but retirement must win before any *subsequent* admission.
    const pending = client.callTool({ name: "read", arguments: { rootID, path: "tiny.txt" } })
      .then((value) => ({ delivered: true, rejected: value.isError === true }))
      .catch(() => ({ delivered: false, rejected: true }))
    const stopped = await OxpHost.stop()
    const settled = await pending
    if (stopped.endpoint.state !== "stopped") throw new Error("Racing endpoint stop did not settle")
    const state = await OxpHost.getState()
    if (state.endpoint.state !== "stopped") throw new Error("Old listener resurrected after stop")
    // A new request on the retired secret URL must never reach the previous
    // execution owner even if the racing first call happened to finish.
    let oldEndpointRejected = false
    try {
      await fetch(enabled.endpoint.url, { method: "POST", body: "{}" })
    } catch {
      oldEndpointRejected = true
    }
    if (!oldEndpointRejected) throw new Error("Retired OXP endpoint still accepts requests")
    console.log("OXP_RACE", JSON.stringify({ stopped: true, oldEndpointRejected, settled }))
    verified = true
  } else {
  const count = 100
  const results = await Promise.all(Array.from({ length: count }, (_, index) =>
    client.callTool(index % 2
      ? { name: "read", arguments: { rootID, path: "tiny.txt" } }
      : { name: "openfork_info", arguments: { action: "status" } },
    ),
  ))
  if (results.some((result) => result.isError)) {
    const error = results.find((row) => row.isError)
    throw new Error("Concurrent first OXP operations failed: " + JSON.stringify(error).slice(0, 800))
  }
  console.log("OXP_EXEC", JSON.stringify({
    ms: Math.round(performance.now() - started),
    heapMiB: Math.round(process.memoryUsage().heapUsed / 1048576),
    count: results.length,
    calls: (await OxpHost.getState()).metrics.calls,
  }))
  await OxpHost.setEnabled(false)
  const denied = await client.callTool({ name: "read", arguments: { rootID, path: "tiny.txt" } })
  if (!denied.isError) throw new Error("Revoked OXP grant unexpectedly allowed a read")
  const after = await OxpHost.getState()
  if (after.enabled) throw new Error("Host did not persist disabled state")
  console.log("OXP_REVOKED", JSON.stringify({ rejected: denied.isError, code: denied.structuredContent?.error }))
  verified = true
  }
} finally {
  await client.close().catch(() => undefined)
  await OxpHost.stop()
  await OxpHost.dispose()
  if (process.env.OXP_TEST_CATALOG_FIRST === "1") {
    // Native V1 catalog lookup materializes a disposable instance in the
    // application-wide InstanceStore. The host must not dispose real app
    // instances; only this isolated fixture owns its entire test process.
    const { disposeAllInstances } = await import("../../src/project/instance-runtime")
    await disposeAllInstances()
  }
  console.log("OXP_STOPPED", JSON.stringify({ stopped: true }))
  if (verified && process.env.OXP_TEST_CATALOG_FIRST === "1") {
    // Native V1 Instance/AgentCatalog initializes app-global watchers that
    // legitimately outlive the OXP connector. This is an isolated subprocess
    // with all assertions and OXP/Instance cleanup already completed; exit
    // explicitly rather than treating unrelated app-global lifetime as OXP.
    process.exit(0)
  }
}
