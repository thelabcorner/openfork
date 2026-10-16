import { expect, test } from "bun:test"
import type { ServerConnection } from "./server"
import { sameServerTransport, snapshotServerTransport } from "./server-transport-identity"

test("server SDK ownership survives presentation labels, not proxy or authorization rotation", () => {
  const old: ServerConnection.Any = {
    type: "sidecar", variant: "base", displayName: "Local",
    http: { url: "http://localhost:5100", username: "alice", password: "first" },
  }
  const snapshot = snapshotServerTransport(old)
  expect(sameServerTransport(snapshot, old)).toBe(true)
  expect(sameServerTransport(snapshot, { ...old, displayName: "Renamed" })).toBe(true)
  old.http.password = "second"
  expect(sameServerTransport(snapshot, old)).toBe(false)
  expect(snapshot.http.password).toBe("first")
  const replaced = snapshotServerTransport(old)
  old.http.url = "http://localhost:5200"
  expect(sameServerTransport(replaced, old)).toBe(false)
  const ssh: ServerConnection.Any = { type: "ssh", host: "one", http: { url: "http://localhost:6000" } }
  expect(sameServerTransport(ssh, { ...ssh, host: "two" })).toBe(false)
  const http: ServerConnection.Any = { type: "http", http: { url: "https://host" }, authToken: true }
  expect(sameServerTransport(http, { ...http, authToken: false })).toBe(false)
})