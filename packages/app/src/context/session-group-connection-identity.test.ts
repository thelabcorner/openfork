import { expect, test } from "bun:test"
import type { ServerConnection } from "./server"
import { createSessionGroupConnectionRevisions, sameSessionGroupConnection } from "./session-group-connection-identity"

test("display label changes preserve the same cache, auth and sidecar proxy changes do not", () => {
  const sidecar: ServerConnection.Any = {
    type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4150" }, displayName: "Local",
  }
  expect(sameSessionGroupConnection(sidecar, { ...sidecar, displayName: "Renamed" })).toBe(true)
  expect(sameSessionGroupConnection(sidecar, { ...sidecar, http: { url: "http://127.0.0.1:4160" } })).toBe(false)
  expect(sameSessionGroupConnection(sidecar, { ...sidecar, http: { ...sidecar.http, password: "new" } })).toBe(false)
  const http: ServerConnection.Any = {
    type: "http", http: { url: "https://example.test", username: "alice", password: "secret" }, authToken: true,
  }
  expect(sameSessionGroupConnection(http, { ...http, label: "Only presentation" })).toBe(true)
  expect(sameSessionGroupConnection(http, { ...http, authToken: false })).toBe(false)
  expect(sameSessionGroupConnection(http, { ...http, http: { ...http.http, username: "bob" } })).toBe(false)
  const ssh: ServerConnection.Any = {
    type: "ssh", host: "node.local", http: { url: "http://127.0.0.1:5000" },
  }
  expect(sameSessionGroupConnection(ssh, { ...ssh, http: { url: "http://127.0.0.1:5001" } })).toBe(false)
  expect(sameSessionGroupConnection(ssh, sidecar)).toBe(false)
})

test("detects same-key proxy and authorization rotations despite in-place mutation", () => {
  const revisions = createSessionGroupConnectionRevisions((conn) =>
    (conn.type === "http" ? conn.http.url : "sidecar") as ServerConnection.Key,
  )
  const local: ServerConnection.Any = {
    type: "sidecar", variant: "base", http: { url: "http://127.0.0.1:4000" },
  }
  const remote: ServerConnection.Any = {
    type: "http", http: { url: "https://example.test", username: "one", password: "secret" },
  }
  const localKey = "sidecar" as ServerConnection.Key
  const remoteKey = "https://example.test" as ServerConnection.Key
  expect(revisions.update([local, remote])).toEqual({ removed: [], changed: [] })
  local.http.url = "http://127.0.0.1:5000"
  expect(revisions.update([local, { ...remote, displayName: "Renamed" }])).toEqual({
    removed: [], changed: [localKey],
  })
  remote.http.password = "rotated"
  expect(revisions.update([local, remote])).toEqual({ removed: [], changed: [remoteKey] })
  expect(revisions.update([local])).toEqual({ removed: [remoteKey], changed: [] })
})