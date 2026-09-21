import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { instanceIdentity } from "../../src/server/shared/instance-identity"
import { publishServiceDescriptor, SERVICE_DISCOVERY_SCHEMA_VERSION } from "../../src/server/service-discovery"
import { tmpdir } from "../fixture/fixture"

describe("server service discovery", () => {
  test("publishes the bound loopback origin with process identity and revokes only its own bytes", async () => {
    await using tmp = await tmpdir()
    const stale = path.join(tmp.path, "stale.json")
    await fs.writeFile(stale, JSON.stringify({ schemaVersion: 1, processID: 2_000_000_000 }), "utf8")
    const lease = await publishServiceDescriptor(new URL("http://127.0.0.1:63841"), { directory: tmp.path })
    expect(lease).toBeDefined()
    expect(await fs.stat(stale).then(() => true, () => false)).toBe(false)

    const descriptor = JSON.parse(await fs.readFile(lease!.file, "utf8"))
    expect(descriptor).toEqual({
      schemaVersion: SERVICE_DISCOVERY_SCHEMA_VERSION,
      url: "http://127.0.0.1:63841",
      ...instanceIdentity(),
    })

    await lease!.revoke()
    expect(await fs.stat(lease!.file).then(() => true, () => false)).toBe(false)

    const second = await publishServiceDescriptor(new URL("http://127.0.0.1:63842"), { directory: tmp.path })
    expect(second).toBeDefined()
    await fs.writeFile(second!.file, '{"newer":true}\n', "utf8")
    await second!.revoke()
    expect(await fs.readFile(second!.file, "utf8")).toBe('{"newer":true}\n')
  })

  test("does not advertise non-loopback listeners", async () => {
    await using tmp = await tmpdir()
    const lease = await publishServiceDescriptor(new URL("http://192.168.1.5:4096"), { directory: tmp.path })
    expect(lease).toBeUndefined()
    expect(await fs.readdir(tmp.path)).toEqual([])
  })
})
