import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { agentTokenPath, deviceAuthorization, parseAgentToken, readAgentToken, writeAgentToken } from "./agent-token"
import { provisionAgentToken, tokenStillWorks } from "./agent-token-provision"
import { AGENT_DEVICE_NAME, AGENT_TOKEN_VERSION } from "./constants"

const dirs: string[] = []
const servers: http.Server[] = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "opencode-agent-token-"))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const server of servers.splice(0)) {
    server.closeAllConnections?.()
    await new Promise<void>((done) => server.close(() => done()))
  }
})

type Stub = {
  /** Tokens the fake sidecar currently accepts. */
  valid: Set<string>
  /** Basic auth value required by /pair/begin. */
  password: string
  minted: string[]
  beginCalls: number
}

async function sidecar(stub: Partial<Stub> = {}) {
  const state: Stub = {
    valid: stub.valid ?? new Set<string>(),
    password: stub.password ?? "master-password",
    minted: [],
    beginCalls: 0,
  }
  let nextCode = "AAA111"
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk as Buffer))
    request.on("end", () => {
      const auth = request.headers.authorization ?? ""
      const json = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" })
        response.end(JSON.stringify(body))
      }

      if (request.url === "/pair/begin") {
        state.beginCalls++
        const expected = `Basic ${Buffer.from(`opencode:${state.password}`).toString("base64")}`
        if (auth !== expected) return json(401, { error: "unauthorized" })
        return json(200, { code: nextCode, url: "http://x/#pair=x", expiresAt: "" })
      }

      if (request.url === "/pair/claim") {
        const body = JSON.parse(Buffer.concat(chunks).toString() || "{}") as { code?: string; name?: string }
        if (body.code !== nextCode) return json(400, { name: "PairCodeError" })
        nextCode = `${nextCode}Z`
        const token = `token-${state.minted.length + 1}`
        state.minted.push(token)
        state.valid.add(token)
        return json(200, {
          token,
          device: { id: `dev-${state.minted.length}`, name: body.name ?? "" },
          server: { name: "opencode", version: "0" },
        })
      }

      // Every other path is the authenticated surface.
      const accepted = [...state.valid].some((token) => auth === deviceAuthorization(token))
      if (!accepted) return json(401, { error: "unauthorized" })
      return json(200, { ok: true })
    })
  })
  const url = await new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`))
  })
  servers.push(server)
  return { url, state }
}

describe("agent token file", () => {
  test("round-trips and is readable by path helper", () => {
    const dir = tempDir()
    const file = agentTokenPath(dir)
    expect(file.endsWith(".opencode-dev-agent-token.json")).toBe(true)

    writeAgentToken(file, {
      version: AGENT_TOKEN_VERSION,
      token: "abc",
      deviceID: "dev-1",
      deviceName: AGENT_DEVICE_NAME,
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    expect(readAgentToken(file)?.token).toBe("abc")
    // Pretty-printed so a human debugging at 3am can read it without a parser.
    expect(readFileSync(file, "utf8")).toContain('"token": "abc"')
  })

  test("rejects a corrupt, empty, or future-versioned file rather than guessing", () => {
    expect(parseAgentToken("not json")).toBeUndefined()
    expect(parseAgentToken("{}")).toBeUndefined()
    expect(parseAgentToken(JSON.stringify({ version: 1, token: "" }))).toBeUndefined()
    expect(parseAgentToken(JSON.stringify({ version: 99, token: "abc" }))).toBeUndefined()
  })

  test("missing file reads as undefined", () => {
    expect(readAgentToken(agentTokenPath(tempDir()))).toBeUndefined()
  })

  test("builds the same Authorization value the PWA sends", () => {
    expect(deviceAuthorization("abc")).toBe(`Basic ${btoa("device:abc")}`)
  })
})

describe("provisioning", () => {
  test("mints a token on first run and writes it", async () => {
    const dir = tempDir()
    const back = await sidecar()

    const result = await provisionAgentToken({
      file: agentTokenPath(dir),
      url: back.url,
      username: "opencode",
      password: back.state.password,
    })
    expect(result).toMatchObject({ ok: true, reused: false })
    expect(back.state.minted).toHaveLength(1)
    const stored = readAgentToken(agentTokenPath(dir))
    expect(stored?.token).toBe(back.state.minted[0]!)
    expect(stored?.deviceName).toBe(AGENT_DEVICE_NAME)
  })

  test("reuses the stored token across restarts instead of re-pairing", async () => {
    const dir = tempDir()
    const back = await sidecar()
    const options = {
      file: agentTokenPath(dir),
      url: back.url,
      username: "opencode",
      password: back.state.password,
    }

    const first = await provisionAgentToken(options)
    const second = await provisionAgentToken(options)
    const third = await provisionAgentToken(options)

    expect(first).toMatchObject({ ok: true, reused: false })
    expect(second).toMatchObject({ ok: true, reused: true })
    expect(third).toMatchObject({ ok: true, reused: true })
    // The whole point: one pairing, ever.
    expect(back.state.minted).toHaveLength(1)
    expect(back.state.beginCalls).toBe(1)
  })

  test("re-mints when the stored token was revoked", async () => {
    const dir = tempDir()
    const back = await sidecar()
    const options = {
      file: agentTokenPath(dir),
      url: back.url,
      username: "opencode",
      password: back.state.password,
    }

    await provisionAgentToken(options)
    back.state.valid.clear() // the device was forgotten in Settings
    const again = await provisionAgentToken(options)

    expect(again).toMatchObject({ ok: true, reused: false })
    expect(back.state.minted).toHaveLength(2)
    expect(readAgentToken(agentTokenPath(dir))?.token).toBe(back.state.minted[1]!)
  })

  test("keeps the token when the server is merely unreachable", async () => {
    const dir = tempDir()
    const file = agentTokenPath(dir)
    writeAgentToken(file, {
      version: AGENT_TOKEN_VERSION,
      token: "still-good",
      deviceID: "dev-1",
      deviceName: AGENT_DEVICE_NAME,
      createdAt: "2026-01-01T00:00:00.000Z",
    })

    // A sidecar that is still starting must not cost us the credential.
    const result = await provisionAgentToken({
      file,
      url: "http://127.0.0.1:1",
      username: "opencode",
      password: "master-password",
      timeoutMs: 300,
    })
    expect(result).toMatchObject({ ok: true, reused: true })
    expect(readAgentToken(file)?.token).toBe("still-good")
  })

  test("reports a bad master password instead of writing junk", async () => {
    const dir = tempDir()
    const back = await sidecar()

    const result = await provisionAgentToken({
      file: agentTokenPath(dir),
      url: back.url,
      username: "opencode",
      password: "wrong",
    })
    expect(result).toMatchObject({ ok: false, reason: "begin-failed" })
    expect(readAgentToken(agentTokenPath(dir))).toBeUndefined()
  })

  test("replaces a corrupt token file", async () => {
    const dir = tempDir()
    const file = agentTokenPath(dir)
    writeFileSync(file, "{ truncated", "utf8")
    const back = await sidecar()

    const result = await provisionAgentToken({
      file,
      url: back.url,
      username: "opencode",
      password: back.state.password,
    })
    expect(result).toMatchObject({ ok: true, reused: false })
    expect(readAgentToken(file)?.token).toBe(back.state.minted[0]!)
  })

  test("tokenStillWorks distinguishes rejected from unreachable", async () => {
    const back = await sidecar({ valid: new Set(["good"]) })
    expect(await tokenStillWorks({ url: back.url, token: "good" })).toBe(true)
    expect(await tokenStillWorks({ url: back.url, token: "bad" })).toBe(false)
    expect(await tokenStillWorks({ url: "http://127.0.0.1:1", token: "good", timeoutMs: 300 })).toBe(true)
  })
})
