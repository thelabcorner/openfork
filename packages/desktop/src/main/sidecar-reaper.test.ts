import { describe, expect, test } from "bun:test"
import { validatePreviousSidecar } from "./sidecar-reaper"
import { parseHandshake } from "../../../mobile/dev/handshake"
import type { DevHandshake } from "../../../mobile/dev/handshake"

const handshake: DevHandshake = {
  version: 2,
  url: "http://127.0.0.1:4000",
  instanceID: "instance-old",
  pid: 100,
  startedAt: "2026-09-28T10:00:00.000Z",
  sidecarPID: 200,
  sidecarStartedAt: "2026-09-28T10:00:01.000Z",
}
const electronPath = "C:\\Program Files\\OpenFork\\OpenFork.exe"
const process = {
  pid: 200,
  parentPID: 100,
  createdAt: "2026-09-28T10:00:01.100Z",
  executablePath: electronPath,
  commandLine: '"C:\\Program Files\\OpenFork\\OpenFork.exe" --type=utility --utility-sub-type=node.mojom.NodeService --inspect=127.0.0.1:0',
}

describe("previous sidecar ownership checks", () => {
  test("handshake inspector metadata accepts loopback only", () => {
    const base = JSON.stringify({ url: "http://127.0.0.1:1", instanceID: "i", inspectorURL: "ws://127.0.0.1:9229/abc" })
    expect(parseHandshake(base)?.inspectorURL).toBe("ws://127.0.0.1:9229/abc")
    const foreign = JSON.parse(base) as { inspectorURL: string }
    foreign.inspectorURL = "ws://0.0.0.0:9229/abc"
    expect(parseHandshake(JSON.stringify(foreign))?.inspectorURL).toBeUndefined()
  })
  test("accepts only the handshake's matching utility process generation and app executable", () => {
    expect(validatePreviousSidecar(handshake, process, electronPath).ok).toBe(true)
  })
  test("can identify a hung predecessor without requiring its event loop to answer HTTP", () => {
    // The reaper's ownership proof comes from the durable handshake plus OS
    // process incarnation, so an event-loop hang does not make the proof depend
    // on an HTTP response from the process being reaped.
    expect(validatePreviousSidecar(handshake, process, electronPath)).toMatchObject({
      ok: true,
      instanceID: "instance-old",
      pid: 200,
    })
  })
  test("rejects stale handshakes without sidecar identity", () => {
    expect(validatePreviousSidecar({ ...handshake, sidecarPID: undefined }, process, electronPath)).toMatchObject({ ok: false })
  })
  test("rejects foreign processes even if their PID is in the handshake", () => {
    expect(validatePreviousSidecar(handshake, { ...process, commandLine: "opencode serve" }, electronPath)).toMatchObject({ reason: "foreign-process" })
  })
  test("rejects PID reuse with a different process start time", () => {
    expect(validatePreviousSidecar(handshake, { ...process, createdAt: "2026-09-28T11:00:01.100Z" }, electronPath)).toMatchObject({ reason: "pid-reused-or-start-mismatch" })
  })
})
