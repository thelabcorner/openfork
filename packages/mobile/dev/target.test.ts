import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HANDSHAKE_VERSION, IDENTITY_PATH, handshakePath, parseHandshake, writeHandshake } from "./handshake"
import { createTargetResolver, probeIdentity } from "./target"

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-handshake-"))
  return { dir, file: handshakePath(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function publish(file: string, overrides: Partial<Parameters<typeof writeHandshake>[1]> = {}) {
  writeHandshake(file, {
    version: HANDSHAKE_VERSION,
    url: "http://127.0.0.1:63841",
    instanceID: "instance-a",
    pid: 4242,
    startedAt: new Date().toISOString(),
    ...overrides,
  })
}

/** Minimal stand-in for a server answering (or refusing) `/instance/identity`. */
function fakeFetch(handler: (url: string) => Response | Promise<Response> | Error) {
  return (async (input: URL | RequestInfo) => {
    const result = await handler(String(input))
    if (result instanceof Error) throw result
    return result
  }) as unknown as typeof fetch
}

const identityResponse = (instanceID: string) =>
  new Response(JSON.stringify({ instanceID, processID: 99, version: "1.18.27" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

describe("probeIdentity", () => {
  test("accepts the instance it was told to expect", async () => {
    const result = await probeIdentity("http://127.0.0.1:63841", {
      expect: "instance-a",
      fetchImpl: fakeFetch((url) => {
        expect(url).toBe(`http://127.0.0.1:63841${IDENTITY_PATH}`)
        return identityResponse("instance-a")
      }),
    })
    expect(result).toEqual({ ok: true, identity: { instanceID: "instance-a", processID: 99, version: "1.18.27" } })
  })

  test("rejects a different opencode holding the same port", async () => {
    const result = await probeIdentity("http://127.0.0.1:63841", {
      expect: "instance-a",
      fetchImpl: fakeFetch(() => identityResponse("instance-b")),
    })
    expect(result).toMatchObject({ ok: false, reason: "mismatch" })
  })

  test("treats the SPA HTML fallback as an outdated server, not a live one", async () => {
    const result = await probeIdentity("http://127.0.0.1:63841", {
      expect: "instance-a",
      fetchImpl: fakeFetch(
        () =>
          new Response("<!doctype html><title>opencode</title>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ),
    })
    expect(result).toMatchObject({ ok: false, reason: "outdated" })
  })

  test("treats a 404 as an opencode too old to identify itself", async () => {
    const result = await probeIdentity("http://127.0.0.1:63841", {
      fetchImpl: fakeFetch(() => new Response("", { status: 404 })),
    })
    expect(result).toMatchObject({ ok: false, reason: "outdated" })
  })

  test("reports a refused connection as unreachable", async () => {
    const result = await probeIdentity("http://127.0.0.1:63841", {
      fetchImpl: fakeFetch(() => new Error("connect ECONNREFUSED")),
    })
    expect(result).toMatchObject({ ok: false, reason: "unreachable" })
  })

  test("refuses an unclaimed instance when there is nothing to compare against", async () => {
    const result = await probeIdentity("http://127.0.0.1:63841", {
      fetchImpl: fakeFetch(() => identityResponse("anon:1234")),
    })
    expect(result).toMatchObject({ ok: false, reason: "unmanaged" })
  })

  test("still pins to an unclaimed instance the handshake explicitly names", async () => {
    // The v2 daemon path: the desktop attaches to a server it did not spawn,
    // records the id that server reports, and pins to it.
    const result = await probeIdentity("http://127.0.0.1:63841", {
      expect: "anon:1234",
      fetchImpl: fakeFetch(() => identityResponse("anon:1234")),
    })
    expect(result.ok).toBe(true)
  })
})

describe("createTargetResolver", () => {
  test("refuses to bind when no desktop has published a handshake", async () => {
    const { file, cleanup } = scratch()
    try {
      const resolver = createTargetResolver({ file, fetchImpl: fakeFetch(() => identityResponse("instance-a")) })
      const result = await resolver.resolve()
      expect(result).toMatchObject({ ok: false, code: "DesktopSidecarUnavailableError" })
      expect(resolver.verifiedUrl()).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("binds once the target echoes the published instance", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file)
      const resolver = createTargetResolver({ file, fetchImpl: fakeFetch(() => identityResponse("instance-a")) })
      const result = await resolver.resolve()
      expect(result).toMatchObject({ ok: true, url: "http://127.0.0.1:63841", instanceID: "instance-a" })
      expect(resolver.verifiedUrl()).toBe("http://127.0.0.1:63841")
    } finally {
      cleanup()
    }
  })

  test("refuses a recycled port now owned by another opencode", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file)
      const resolver = createTargetResolver({ file, fetchImpl: fakeFetch(() => identityResponse("someone-else")) })
      const result = await resolver.resolve()
      expect(result).toMatchObject({ ok: false, code: "DesktopSidecarInstanceMismatchError" })
      // Fail closed: the proxy must have nothing to fall back to.
      expect(resolver.verifiedUrl()).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("refuses a handshake written by a different `bun run dev`", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file, { runID: "run-two" })
      let probed = false
      const resolver = createTargetResolver({
        file,
        runID: "run-one",
        fetchImpl: fakeFetch(() => {
          probed = true
          return identityResponse("instance-a")
        }),
      })
      const result = await resolver.resolve()
      expect(result).toMatchObject({ ok: false, code: "DesktopSidecarForeignRunError" })
      expect(probed).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("refuses a handshake from an older launcher when this PWA has a run id", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file)
      const resolver = createTargetResolver({
        file,
        runID: "run-one",
        override: "http://127.0.0.1:4096",
        fetchImpl: fakeFetch(() => identityResponse("instance-a")),
      })
      const result = await resolver.resolve()
      expect(result).toMatchObject({ ok: false, code: "DesktopSidecarForeignRunError" })
    } finally {
      cleanup()
    }
  })

  test("rebinds when the desktop restarts under a new instance id", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file)
      let answer = "instance-a"
      const resolver = createTargetResolver({ file, fetchImpl: fakeFetch(() => identityResponse(answer)) })
      expect(await resolver.resolve()).toMatchObject({ ok: true, instanceID: "instance-a" })

      publish(file, { instanceID: "instance-b", url: "http://127.0.0.1:50000" })
      answer = "instance-b"
      // A new instance id is a new cache key, so this must not serve the stale
      // binding even though the revalidate window has not elapsed.
      expect(await resolver.resolve()).toMatchObject({
        ok: true,
        instanceID: "instance-b",
        url: "http://127.0.0.1:50000",
      })
    } finally {
      cleanup()
    }
  })

  test("stops binding as soon as the handshake is revoked", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file)
      const resolver = createTargetResolver({ file, fetchImpl: fakeFetch(() => identityResponse("instance-a")) })
      expect(await resolver.resolve()).toMatchObject({ ok: true })
      rmSync(file)
      expect(await resolver.resolve()).toMatchObject({ ok: false, code: "DesktopSidecarUnavailableError" })
      expect(resolver.verifiedUrl()).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  test("serves repeated requests from cache, then revalidates", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file)
      let probes = 0
      let clock = 0
      const resolver = createTargetResolver({
        file,
        revalidateMs: 1000,
        now: () => clock,
        fetchImpl: fakeFetch(() => {
          probes++
          return identityResponse("instance-a")
        }),
      })
      await resolver.resolve()
      await resolver.resolve()
      expect(probes).toBe(1)
      clock = 2000
      await resolver.resolve()
      expect(probes).toBe(2)
    } finally {
      cleanup()
    }
  })

  test("verifies an env override too, and pins it to the first answer", async () => {
    const { file, cleanup } = scratch()
    try {
      let answer = "override-instance"
      const resolver = createTargetResolver({
        file,
        override: "http://127.0.0.1:4096",
        revalidateMs: 0,
        fetchImpl: fakeFetch(() => identityResponse(answer)),
      })
      expect(await resolver.resolve()).toMatchObject({ ok: true, source: "override", instanceID: "override-instance" })
      answer = "a-completely-different-server"
      expect(await resolver.resolve()).toMatchObject({ ok: false, code: "DesktopSidecarInstanceMismatchError" })
    } finally {
      cleanup()
    }
  })

  test("rejects a handshake from an incompatible version without probing", async () => {
    const { file, cleanup } = scratch()
    try {
      writeFileSync(file, JSON.stringify({ version: 99, url: "http://127.0.0.1:1234", instanceID: "x" }))
      let probed = false
      const resolver = createTargetResolver({
        file,
        fetchImpl: fakeFetch(() => {
          probed = true
          return identityResponse("x")
        }),
      })
      expect(await resolver.resolve()).toMatchObject({ ok: false, code: "DesktopSidecarHandshakeVersionError" })
      expect(probed).toBe(false)
    } finally {
      cleanup()
    }
  })

  test("rejects a truncated or corrupt handshake", async () => {
    const { file, cleanup } = scratch()
    try {
      writeFileSync(file, '{"version":2,"url":"http://12')
      const resolver = createTargetResolver({ file, fetchImpl: fakeFetch(() => identityResponse("x")) })
      expect(await resolver.resolve()).toMatchObject({ ok: false, code: "DesktopSidecarHandshakeInvalidError" })
    } finally {
      cleanup()
    }
  })

  test("collapses concurrent requests onto one probe", async () => {
    const { file, cleanup } = scratch()
    try {
      publish(file)
      let probes = 0
      const resolver = createTargetResolver({
        file,
        fetchImpl: fakeFetch(async () => {
          probes++
          await new Promise((resolve) => setTimeout(resolve, 5))
          return identityResponse("instance-a")
        }),
      })
      await Promise.all([resolver.resolve(), resolver.resolve(), resolver.resolve()])
      expect(probes).toBe(1)
    } finally {
      cleanup()
    }
  })
})

describe("parseHandshake", () => {
  test("rejects the v1 bare-URL format outright", () => {
    // The old file was tracked in git, so a checkout could resurrect a dead
    // port. It must never be interpreted as a binding.
    expect(parseHandshake("http://127.0.0.1:63841")).toBeUndefined()
  })

  test("rejects a handshake with no identity to verify", () => {
    expect(parseHandshake(JSON.stringify({ version: 2, url: "http://127.0.0.1:1" }))).toBeUndefined()
  })

  test("normalises a trailing slash so cache keys stay stable", () => {
    const parsed = parseHandshake(JSON.stringify({ version: 2, url: "http://127.0.0.1:1/", instanceID: "a" }))
    expect(parsed?.url).toBe("http://127.0.0.1:1")
  })
})

describe("writeHandshake", () => {
  test("round-trips and leaves no temp file behind", () => {
    const { dir, file, cleanup } = scratch()
    try {
      publish(file, { runID: "run-one", channel: "dev" })
      const read = parseHandshake(require("node:fs").readFileSync(file, "utf8"))
      expect(read).toMatchObject({
        url: "http://127.0.0.1:63841",
        instanceID: "instance-a",
        runID: "run-one",
        channel: "dev",
        pid: 4242,
      })
      expect(
        require("node:fs")
          .readdirSync(dir)
          .filter((name: string) => name.endsWith(".tmp")),
      ).toEqual([])
    } finally {
      cleanup()
    }
  })
})
