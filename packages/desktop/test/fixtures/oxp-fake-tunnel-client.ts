import { spawn } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"

if (process.argv.includes("--sleeper")) {
  setInterval(() => undefined, 1_000)
} else {
  const arg = (name: string) => {
    const at = process.argv.indexOf(name)
    return at >= 0 ? process.argv[at + 1] : undefined
  }
  const mode = process.env.OXP_FAKE_MODE ?? "connected"
  const healthFile = arg("--health-file")
  const launchFile = process.env.OXP_FAKE_LAUNCH_FILE
  const childPidFile = process.env.OXP_FAKE_CHILD_PID_FILE

  let launchIndex = 1
  if (launchFile) {
    try {
      launchIndex = readFileSync(launchFile, "utf8").trim().split(/\s+/).filter(Boolean).length + 1
    } catch {}
    appendFileSync(launchFile, `${process.pid}\n`)
  }
  const effectiveMode = mode === "exit-once" && launchIndex > 1 ? "connected" : mode === "exit-once" ? "exit" : mode

  if (childPidFile) {
    const child = spawn(process.execPath, [import.meta.path, "--sleeper"], {
      windowsHide: true,
      stdio: "ignore",
    })
    if (!child.pid) throw new Error("fake tunnel child did not start")
    writeFileSync(childPidFile, String(child.pid))
  }

  if (effectiveMode === "auth") {
    console.error(JSON.stringify({ level: "ERROR", msg: "control plane returned HTTP 401 Unauthorized" }))
    setInterval(() => undefined, 1_000)
  } else if (effectiveMode === "exit") {
    setTimeout(() => process.exit(7), 50)
  } else {
    if (!healthFile) throw new Error("missing --health-file")
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/readyz") return new Response("ready")
        if (url.pathname === "/metrics") {
          const now = Math.floor(Date.now() / 1_000)
          const last = effectiveMode === "offline" ? now - 300 : effectiveMode === "unproven" ? 0 : now
          return new Response(
            [
              `commands_poll_last_successful_timestamp_seconds ${last}`,
              "commands_poll_cycles_total 1",
              `commands_poll_errors_total ${effectiveMode === "offline" ? 1 : 0}`,
            ].join("\n"),
          )
        }
        if (url.pathname === "/api/status") {
          return Response.json({
            version: "fake-1",
            uptime_seconds: 1,
            control_plane_route: { target: "fake.openai.test", route_mode: "direct", proxy_source: "none" },
            channels: [{ name: "main", probe_status: "ok" }],
          })
        }
        return new Response("not found", { status: 404 })
      },
    })
    writeFileSync(healthFile, `http://127.0.0.1:${server.port}/\n`)
  }
}
