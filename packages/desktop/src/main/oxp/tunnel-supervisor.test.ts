import { afterEach, describe, expect, test } from "bun:test"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildTunnelChildEnv, startTunnelSupervisor, type OxpTunnelReport } from "./tunnel-supervisor"

const fixture = path.resolve(import.meta.dir, "../../../test/fixtures/oxp-fake-tunnel-client.ts")
const dirs: string[] = []
const handles: Array<{ stop(): Promise<void> }> = []

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop().catch(() => undefined)))
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oxp-tunnel-supervisor-test-"))
  dirs.push(dir)
  return dir
}

async function waitFor<T>(
  read: () => T | undefined | null | false | Promise<T | undefined | null | false>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value as T
    await Bun.sleep(20)
  }
  throw new Error("condition did not become true before timeout")
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function launch(mode: string, options?: { child?: boolean }) {
  const dir = await temp()
  const launches = path.join(dir, "launches.txt")
  const childPid = path.join(dir, "child.pid")
  const reports: OxpTunnelReport[] = []
  const handle = await startTunnelSupervisor({
    binary: process.execPath,
    launch: (healthFile) => ({
      args: [fixture, "--health-file", healthFile],
      env: {
        OXP_FAKE_MODE: mode,
        OXP_FAKE_LAUNCH_FILE: launches,
        ...(options?.child ? { OXP_FAKE_CHILD_PID_FILE: childPid } : {}),
      },
    }),
    secrets: ["fake-secret", "http://127.0.0.1:1/mcp/fake"],
    report: (report) => reports.push(report),
  })
  handles.push(handle)
  return { dir, launches, childPid, reports, handle }
}

async function launchPids(file: string) {
  try {
    return (await fs.readFile(file, "utf8"))
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
  } catch {
    return []
  }
}

describe("OXP tunnel supervisor", () => {
  test("does not inherit unrelated provider or application credentials into tunnel-client", () => {
    const env = buildTunnelChildEnv(
      {
        CONTROL_PLANE_API_KEY: "oxp-key",
        MCP_SERVER_URL: "url=http://127.0.0.1:1/mcp/token,channel=main",
      },
      {
        PATH: "C:\\Windows",
        HTTPS_PROXY: "http://proxy.example",
        OPENAI_API_KEY: "provider-secret",
        ANTHROPIC_API_KEY: "provider-secret-2",
        AWS_SECRET_ACCESS_KEY: "provider-secret-3",
        OPENCODE_SERVER_PASSWORD: "sidecar-secret",
        RANDOM_PRIVATE_TOKEN: "private",
      },
    )

    expect(env.PATH).toBe("C:\\Windows")
    expect(env.HTTPS_PROXY).toBe("http://proxy.example")
    expect(env.CONTROL_PLANE_API_KEY).toBe("oxp-key")
    expect(env.MCP_SERVER_URL).toContain("127.0.0.1")
    expect(env.OPENAI_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined()
    expect(env.RANDOM_PRIVATE_TOKEN).toBeUndefined()
  })

  test("proves a healthy remote route and kills the owned process tree on stop", async () => {
    const run = await launch("connected", { child: true })
    await waitFor(() => run.reports.find((report) => report.state === "connected"))
    const parent = await waitFor(async () => (await launchPids(run.launches))[0])
    const child = await waitFor(async () => {
      try {
        return Number((await fs.readFile(run.childPid, "utf8")).trim()) || undefined
      } catch {
        return undefined
      }
    })

    expect(processAlive(parent as number)).toBe(true)
    expect(processAlive(child as number)).toBe(true)
    await run.handle.stop()
    await waitFor(() => !processAlive(parent as number))
    await waitFor(() => !processAlive(child as number))
  }, 10_000)

  test("treats auth rejection as terminal and does not hot-restart", async () => {
    const run = await launch("auth")
    await waitFor(() => run.reports.find((report) => report.state === "auth-failed"))
    await Bun.sleep(2_300)
    expect((await launchPids(run.launches)).length).toBe(1)
    await run.handle.stop()
  }, 8_000)

  test("recovers a crashed client with one bounded restart owner", async () => {
    const run = await launch("exit-once")
    await waitFor(() => run.reports.find((report) => report.state === "connected"), 6_000)
    const count = (await launchPids(run.launches)).length
    expect(count).toBe(2)
    await run.handle.stop()
  }, 8_000)

  test("stop racing a scheduled reconnect wins and prevents a replacement tree", async () => {
    const run = await launch("exit")
    await waitFor(() => run.reports.find((report) => report.detail?.includes("Reconnecting in 2s")))
    await run.handle.stop()
    await Bun.sleep(2_300)
    expect((await launchPids(run.launches)).length).toBe(1)
  }, 8_000)

  test("projects stale control-plane proof as offline while keeping the client alive", async () => {
    const run = await launch("offline")
    const report = await waitFor(() => run.reports.find((item) => item.state === "offline"))
    expect(report.health?.clientVersion).toBe("fake-1")
    expect((await launchPids(run.launches)).length).toBe(1)
    await run.handle.stop()
  }, 8_000)

  test("does not report connected before the first successful control-plane poll", async () => {
    const run = await launch("unproven")
    const report = await waitFor(() =>
      run.reports.find((item) => item.detail?.includes("handshake has not been proven")),
    )
    expect(report.state).toBe("starting")
    expect(run.reports.some((item) => item.state === "connected")).toBe(false)
    await run.handle.stop()
  }, 8_000)
})
