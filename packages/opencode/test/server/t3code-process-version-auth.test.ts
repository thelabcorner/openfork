/**
 * PROCESS / VERSION / AUTH invariants for the T3 Code compatibility facade.
 *
 * EVIDENCE CLASS: current-source process evidence. Every launch below runs
 * `bun src/index.ts`, i.e. the working tree as it stands today, and every HTTP
 * assertion is a real request against a real child server. This is deliberately
 * NOT the same claim as the packaged-binary lane: `dist/` residue in this
 * checkout predates HEAD and cannot speak for source. The two are reported
 * separately and neither stands in for the other.
 *
 * WHY THIS FILE IS SEPARATE FROM THE CONTRACT SUITES:
 *   - `t3code-generation-negotiation.test.ts` is a pure-function oracle: it
 *     transcribes T3's classifier and asserts the VALUES OpenFork presents.
 *   - `t3code-compat-contract.test.ts` asserts legacy route/payload acceptance.
 *   Neither runs a process. This file owns the negotiation INPUTS as observed
 *   from outside the process: what `--version` prints, what the startup line
 *   says, what `/global/health` and `/api/info` actually answer, and what the
 *   auth boundary actually rejects.
 *
 * T3 IMMUTABILITY: nothing here modifies, checks out, or executes T3. T3's
 * decision logic is transcribed verbatim in `test/compat/t3-latest-e2e/
 * t3-latest-probe.ts` and imported, never re-derived, so a correction
 * re-targets that single transcription instead of silently forking it.
 *
 * SOURCE OF EVERY CLAIM, with citations:
 *   - src/compat/t3code.ts:13-16        profile literal + facade version 1.15.13
 *   - src/compat/t3code.ts:35-42        localClientReportedVersion projection
 *   - src/compat/t3code.ts:49-53        localServerListeningProduct spelling
 *   - src/cli-main.ts:52                `--version` consumes the projection
 *   - src/cli/cmd/serve.ts:21           startup line consumes the product name
 *   - handlers/global.ts:652-670        /global/health body, profile vs canonical
 *   - src/server/auth.ts:41-47          Basic header, default username "opencode"
 *   - middleware/authorization.ts:51-58 401 on wrong/absent credentials
 *   - packages/core/src/installation/version.ts:17  dev sentinel "local"
 *
 * NOT IN SCOPE, DELIBERATELY: no auth is weakened anywhere in this file, no T3
 * file is touched, and no route is added. `/api/info` staying unserved is a
 * deliberate conservative facade invariant (see the 404 test below), not a gap.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createConnection, createServer } from "node:net"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import semver from "semver"
import { OpenApi } from "effect/unstable/httpapi"
import {
  OPENFORK_COMPAT_PROFILE_ENV,
  T3_CODE_COMPAT_PROFILE,
  T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
  isT3CodeCompatibilityProfile,
  localClientReportedVersion,
  localServerListeningProduct,
} from "../../src/compat/t3code"
import { OpenCodeHttpApi } from "../../src/server/routes/instance/httpapi/api"
import {
  MINIMUM_OPENCODE_VERSION,
  classifyOpenCodeProbeResponse,
  probeAuthorizationHeader,
  probeOpenCodeServerPaths,
  verifyOpenCodeServerVersion,
} from "../compat/t3-latest-e2e/t3-latest-probe"

const PACKAGE_ROOT = join(import.meta.dir, "..", "..")
const SERVER_USERNAME = "opencode"
const SERVER_PASSWORD = "t3-process-version-auth-pw-0123456789"

/** The exact T3 profile literal. Set as a PROCESS env var for every launch below. */
const T3_PROFILE_ENV = { [OPENFORK_COMPAT_PROFILE_ENV]: T3_CODE_COMPAT_PROFILE } as const
const CANONICAL_ENV = { [OPENFORK_COMPAT_PROFILE_ENV]: undefined } as const

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/**
 * Environment for a current-source launch. `OPENCODE_SERVER_PASSWORD` makes the
 * auth boundary real rather than vacuous; `OPENCODE_DB` is redirected to a temp
 * file so a launch can never touch a developer's real database.
 */
function launchEnv(profile: string | undefined): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...(profile === undefined ? {} : { [OPENFORK_COMPAT_PROFILE_ENV]: profile }),
    OPENCODE_SERVER_PASSWORD: SERVER_PASSWORD,
    OPENCODE_CONFIG_CONTENT: "{}",
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not determine a free port")))
        return
      }
      const { port } = address
      probe.close(() => resolve(port))
    })
  })
}

/** True when something is still accepting TCP connections on the loopback port. */
function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: "127.0.0.1" })
    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    // A connect that neither connects nor errors counts as "not listening"
    // rather than as a hang, so teardown can never deadlock on a half-dead
    // listener.
    const timer = setTimeout(() => finish(false), 1_000)
    socket.on("connect", () => finish(true))
    socket.on("error", () => finish(false))
  })
}

/**
 * Terminates a spawned server AND everything it spawned, then PROVES the port
 * was released instead of assuming it.
 *
 * ROOT CAUSE THIS EXISTS FOR — measured on this machine, not theorised: on
 * Windows `bun` on PATH is `bun.cmd`, so `spawn("bun", ...)` yields a `child.pid`
 * that belongs to a `cmd.exe` shim, and the real `bun.exe` server is a
 * GRANDCHILD. `taskkill /T` walks a LIVE process tree, so invoking it AFTER
 * `child.kill("SIGKILL")` is a no-op: the root is already gone and there is no
 * tree left to traverse.
 *
 * The consequence was measured, not predicted. A run of this file at 22:38 on
 * 2026-10-03 printed a complete summary and left exactly that leak behind: the
 * two `bun src/index.ts serve` grandchildren (ports 21696 and 21697) were still
 * alive ~27 minutes after the suite exited, one still holding its listener, at
 * ~865 MB working set each. `taskkill` on those orphans afterwards named their
 * already-dead parents ("child process of PID 135860 / 143068") — the two
 * `cmd.exe` shims — which confirms the ancestry instead of inferring it. Bun's
 * own "killed 2 dangling processes" line refers to the direct children it reaped;
 * it is NOT evidence the grandchildren died, and reading it as such is exactly
 * what let this leak survive a green-looking run.
 *
 * ORDER IS THEREFORE LOAD-BEARING: tree-kill the still-live root first, fall
 * back to a direct kill, and treat the PORT — not the child's `close` event — as
 * the completion signal.
 */
async function terminate(child: ChildProcess, port: number): Promise<string> {
  const pid = child.pid
  // Detach stdio first, or a surviving grandchild can hold this runner's pipes
  // open (that is what makes an earlier version of this suite print a summary
  // and then hang forever instead of exiting).
  child.stdout?.destroy()
  child.stderr?.destroy()

  // Deliberately REPORTED, not asserted. `treeKilled=false` is legitimately
  // reachable — the shim can exit on its own before taskkill runs, which makes
  // taskkill return non-zero while the port is already free — so pinning
  // `treeKilled === true` on win32 would trade a real leak for a flaky test.
  // The port liveness poll below is the actual proof; this is a diagnostic.
  const treeKilled =
    process.platform === "win32" && pid !== undefined
      ? spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" }).status === 0
      : false

  child.kill("SIGKILL")
  child.unref()

  const deadline = Date.now() + 15_000
  let listening = await isListening(port)
  while (listening && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    listening = await isListening(port)
  }
  return [
    `pid=${pid ?? "none"}`,
    `treeKilled=${treeKilled}`,
    `directKillIssued=true`,
    `port=${port}`,
    listening ? "PORT-STILL-OPEN" : "port-released",
  ].join(" ")
}

interface CommandResult {
  readonly stdout: string
  readonly stderr: string
  readonly code: number | null
}

/** Runs current source with `--version` and returns the real captured streams. */
function runVersion(profile: string | undefined): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["src/index.ts", "--version"], {
      cwd: PACKAGE_ROOT,
      env: launchEnv(profile),
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", reject)
    child.on("close", (code) => resolve({ stdout, stderr, code }))
  })
}

interface LiveServer {
  readonly identity: "profile" | "canonical"
  readonly url: string
  /** The port actually bound, so teardown can be PROVEN rather than assumed. */
  readonly port: number
  readonly rootPid: number | undefined
  readonly startupLine: string
  readonly allOutput: string
  /** Idempotent; returns a report describing how this server was reaped. */
  stop(): Promise<string>
}

/**
 * Starts a real current-source server and resolves only once it has printed its
 * startup line, so every later assertion runs against a server that is actually
 * listening rather than against a guess.
 */
async function startServer(
  identity: "profile" | "canonical",
): Promise<LiveServer> {
  const port = await freePort()
  const dbDir = mkdtempSync(join(tmpdir(), `openfork-t3-pva-${identity}-`))
  const env: NodeJS.ProcessEnv = {
    ...launchEnv(identity === "profile" ? T3_CODE_COMPAT_PROFILE : undefined),
    OPENCODE_DB: join(dbDir, "opencode.db"),
  }
  const child = spawn(
    "bun",
    ["src/index.ts", "serve", "--hostname=127.0.0.1", `--port=${port}`],
    { cwd: PACKAGE_ROOT, env },
  )
  let output = ""
  child.stdout?.on("data", (chunk) => (output += String(chunk)))
  child.stderr?.on("data", (chunk) => (output += String(chunk)))

  const expected = new RegExp(
    `^(opencode|OpenFork) server listening on (http://127\\.0\\.0\\.1:${port})$`,
    "m",
  )
  const deadline = Date.now() + 180_000
  let match: RegExpExecArray | null = null
  while (Date.now() < deadline) {
    match = expected.exec(output)
    if (match) break
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (!match) {
    // Same teardown as the success path, so a failed startup cannot leak either.
    const report = await terminate(child, port)
    throw new Error(
      `${identity} server did not print a startup line within 180s (teardown: ${report})\n--- output ---\n${output.slice(-4000)}`,
    )
  }

  let stopped: Promise<string> | undefined
  return {
    identity,
    url: match[2]!,
    port,
    rootPid: child.pid,
    startupLine: match[0]!,
    allOutput: output,
    stop() {
      // Idempotent because afterAll runs after the in-band teardown test, and a
      // second stop() must not be able to report a fresh success.
      stopped ??= terminate(child, port)
      return stopped
    },
  }
}

interface ProbeResult {
  readonly status: number
  readonly contentType: string | undefined
  readonly body: string
}

async function get(
  server: LiveServer,
  path: string,
  credentials?: { readonly username: string; readonly password: string },
): Promise<ProbeResult> {
  const response = await fetch(`${server.url}${path}`, {
    headers: credentials
      ? { authorization: probeAuthorizationHeader(credentials.password)! }
      : {},
  })
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? undefined,
    body: await response.text(),
  }
}

const CORRECT = { username: SERVER_USERNAME, password: SERVER_PASSWORD } as const

function json(result: ProbeResult): Record<string, unknown> {
  return JSON.parse(result.body) as Record<string, unknown>
}

const mediaType = (result: ProbeResult) =>
  result.contentType?.split(";")[0]?.trim().toLowerCase()

// ---------------------------------------------------------------------------
// 1. CLI VERSION PROJECTION — real subprocesses
// ---------------------------------------------------------------------------

describe("CURRENT-SOURCE `--version` projection (real subprocess)", () => {
  let profile: CommandResult
  let canonical: CommandResult
  let nearMiss: CommandResult

  beforeAll(async () => {
    ;[profile, canonical, nearMiss] = await Promise.all([
      runVersion(T3_CODE_COMPAT_PROFILE),
      runVersion(undefined),
      // One character longer than the real literal.
      runVersion(`${T3_CODE_COMPAT_PROFILE}x`),
    ])
    for (const [label, result] of [
      ["profile", profile],
      ["canonical", canonical],
      ["near-miss", nearMiss],
    ] as const) {
      if (result.code !== 0) {
        throw new Error(`${label} --version exited ${result.code}: ${result.stderr || result.stdout}`)
      }
    }
  }, 240_000)

  test("the exact T3 profile prints the facade version and NOTHING else on stdout", () => {
    // Exact equality, not "contains". T3's parseGenericCliVersion takes the FIRST
    // semver-shaped token in the whole stdout, so one extra log line carrying any
    // version-shaped text would silently change what T3 reads.
    expect(profile.stdout.trim()).toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
    expect(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION).toBe("1.15.13")
    // First-match-wins is the parse rule, so the projection must be the ONLY
    // semver-shaped token present.
    expect(profile.stdout.match(/\d+\.\d+\.\d+/g)).toEqual(["1.15.13"])
  })

  test("canonical current source reports its own native version, never the facade version", () => {
    // This tree is not a release build, so the OPENCODE_VERSION define is absent
    // and InstallationVersion is the non-semver sentinel "local"
    // (packages/core/src/installation/version.ts:17). Stated explicitly so the
    // literal below is never mistaken for a product version claim.
    expect(InstallationVersion).toBe("local")
    expect(canonical.stdout.trim()).toBe("local")
    // The load-bearing part is the negative: canonical identity must not be
    // repointed at a fake OpenCode version by the facade.
    expect(canonical.stdout.trim()).not.toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
    expect(canonical.stdout.trim()).toBe(
      localClientReportedVersion(InstallationVersion, CANONICAL_ENV),
    )
  })

  test("a near-miss profile value is inert — activation is exact equality", () => {
    expect(nearMiss.stdout.trim()).toBe("local")
    expect(isT3CodeCompatibilityProfile({ [OPENFORK_COMPAT_PROFILE_ENV]: `${T3_CODE_COMPAT_PROFILE}x` })).toBe(
      false,
    )
    // Pin the whole near-miss class, not just the one probed above, because a
    // prefix/trim/case-insensitive match would silently widen profile activation
    // to unrelated callers.
    for (const near of [
      `${T3_CODE_COMPAT_PROFILE}x`,
      `${T3_CODE_COMPAT_PROFILE} `,
      ` ${T3_CODE_COMPAT_PROFILE}`,
      T3_CODE_COMPAT_PROFILE.toUpperCase(),
      T3_CODE_COMPAT_PROFILE.replace("v1", "v2"),
      T3_CODE_COMPAT_PROFILE.replace("t3code", "t3"),
    ]) {
      expect(isT3CodeCompatibilityProfile({ [OPENFORK_COMPAT_PROFILE_ENV]: near })).toBe(false)
      expect(localClientReportedVersion("native-sentinel", { [OPENFORK_COMPAT_PROFILE_ENV]: near })).toBe(
        "native-sentinel",
      )
      expect(localServerListeningProduct({ [OPENFORK_COMPAT_PROFILE_ENV]: near })).toBe("OpenFork")
    }
  })
})

// ---------------------------------------------------------------------------
// 2. SERVER IDENTITY + HTTP — real subprocesses, real requests
// ---------------------------------------------------------------------------

describe("CURRENT-SOURCE server identity and negotiation surfaces (real HTTP)", () => {
  let profileServer: LiveServer
  let canonicalServer: LiveServer

  beforeAll(async () => {
    ;[profileServer, canonicalServer] = await Promise.all([
      startServer("profile"),
      startServer("canonical"),
    ])
  }, 300_000)

  // Explicit timeout: the default Bun hook budget is 5s, which this teardown
  // legitimately exceeds (two sequential Windows tree-kills plus a port-liveness
  // poll). Under the default budget the hook was reported as an unnamed failing
  // test — a teardown assertion masquerading as a product failure. Raising the
  // budget keeps the semantics and stops the misreport.
  afterAll(async () => {
    await profileServer?.stop()
    await canonicalServer?.stop()
  }, 120_000)

  test("under the T3 profile the startup line says lowercase `opencode`", () => {
    // Old T3 matched this literal prefix, so the lowercase spelling is retained
    // deliberately. Case matters: `OpenFork` would not match.
    expect(profileServer.startupLine).toBe(
      `opencode server listening on ${profileServer.url}`,
    )
    expect(profileServer.startupLine.startsWith("opencode server listening on ")).toBe(true)
    expect(profileServer.startupLine).not.toContain("OpenFork")
    expect(localServerListeningProduct(T3_PROFILE_ENV)).toBe("opencode")
  })

  test("canonical startup says `OpenFork` and never the lowercase compatibility spelling", () => {
    expect(canonicalServer.startupLine).toBe(
      `OpenFork server listening on ${canonicalServer.url}`,
    )
    expect(canonicalServer.startupLine).not.toContain("opencode server listening")
    expect(localServerListeningProduct(CANONICAL_ENV)).toBe("OpenFork")
  })

  test("profile `/global/health` is EXACTLY healthy + 1.15.13 and carries no path block", async () => {
    const result = await get(profileServer, "/global/health", CORRECT)
    expect(result.status).toBe(200)
    expect(mediaType(result)).toBe("application/json")
    const body = json(result)
    expect(body["healthy"]).toBe(true)
    expect(body["version"]).toBe(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
    // Exactly two keys. Under the profile the handler returns only
    // {healthy, version} (handlers/global.ts:653-658), so a leaked `path` would
    // mean the profile branch stopped being taken.
    expect(Object.keys(body).sort()).toEqual(["healthy", "version"])
    // And the exact live body must classify as T3 v1 through T3's own decoder.
    expect(classifyOpenCodeProbeResponse("/global/health", result)).toEqual({
      generation: "v1",
      version: T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
    })
  })

  test("canonical `/global/health` keeps its native `path` block", async () => {
    const result = await get(canonicalServer, "/global/health", CORRECT)
    expect(result.status).toBe(200)
    expect(mediaType(result)).toBe("application/json")
    const body = json(result)
    expect(body["healthy"]).toBe(true)
    // Canonical identity is NOT projected: it reports the real native version.
    expect(body["version"]).toBe(localClientReportedVersion(InstallationVersion, CANONICAL_ENV))
    const path = body["path"] as Record<string, unknown> | undefined
    expect(path).toBeDefined()
    // The native path block is a real product surface, not T3 decoration.
    expect(Object.keys(path!).sort()).toEqual([
      "config",
      "directory",
      "home",
      "state",
      "worktree",
    ])
    for (const key of ["home", "state", "config", "worktree", "directory"] as const) {
      expect(typeof path![key]).toBe("string")
    }
    // handlers/global.ts:659-668 resolves one directory and reports it under
    // both keys, so these must agree rather than being two independent lookups.
    expect(path!["directory"]).toBe(path!["worktree"])
  })

  test("`/api/info` is a structural 404 on BOTH identities — the load-bearing v1 signal", async () => {
    for (const server of [profileServer, canonicalServer]) {
      const result = await get(server, "/api/info", CORRECT)
      // Pin the STATUS exactly. T3 advances to /global/health on any non-200, so
      // "not a 200 JSON body" would technically pass — but the specific 404 is
      // the deliberate steady state and is what a reviewer must be able to read.
      expect(
        result.status,
        "/api/info answering anything other than 404 risks volunteering a version on T3's first-probed path",
      ).toBe(404)
      expect(mediaType(result)).toBe("application/json")
      // Authenticated, so the 404 is a routing fact and not a 401 in disguise.
      expect(result.status).not.toBe(401)
      // The decisive property: T3's per-path classifier extracts no version.
      expect(classifyOpenCodeProbeResponse("/api/info", result)).toBeUndefined()
    }
    // Structurally absent, not merely unrouted at runtime: no group declares it.
    const spec = OpenApi.fromApi(OpenCodeHttpApi) as {
      paths: Record<string, Record<string, unknown> | undefined>
    }
    expect(spec.paths["/api/info"]).toBeUndefined()
    expect(spec.paths["/global/health"]?.["get"]).toBeDefined()
  })

  test("the observed 404-then-health pair is what actually drives T3 to v1", async () => {
    // T3's probe is mutually exclusive by CONFIGURATION: a non-empty serverUrl
    // runs the server probe, otherwise the binary --version probe. This asserts
    // the server branch only, end to end, from the live responses of the real
    // profile server.
    const info = await get(profileServer, "/api/info", CORRECT)
    const health = await get(profileServer, "/global/health", CORRECT)
    const outcome = probeOpenCodeServerPaths({ "/api/info": info, "/global/health": health })
    expect(outcome).toEqual({
      kind: "identified",
      probed: { generation: "v1", version: T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION },
      path: "/global/health",
    })
    expect(verifyOpenCodeServerVersion(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)).toEqual({ ok: true })
  })

  test("correct Basic authenticates; a wrong or absent password is 401 on BOTH probe paths", async () => {
    // Correct credentials work.
    expect((await get(profileServer, "/global/health", CORRECT)).status).toBe(200)
    // Correct credentials on /api/info still 404 — proving the 404 above is
    // routing, not an auth artifact.
    expect((await get(profileServer, "/api/info", CORRECT)).status).toBe(404)

    const wrong = { username: SERVER_USERNAME, password: `${SERVER_PASSWORD}-wrong` }
    for (const server of [profileServer, canonicalServer]) {
      for (const path of ["/api/info", "/global/health"] as const) {
        // Wrong password: rejected, and it leaks no version on either path.
        const bad = await get(server, path, wrong)
        expect(bad.status, `${path} with a wrong password`).toBe(401)
        expect(classifyOpenCodeProbeResponse(path, bad)).toBe("unauthorized")
        // No credentials at all: the reachable fail-closed state for a
        // password-protected server. T3 omits the header entirely when the
        // configured password is empty, so this is the case that must NOT
        // silently succeed.
        const anonymous = await get(server, path)
        expect(anonymous.status, `${path} with no credentials`).toBe(401)
        expect(classifyOpenCodeProbeResponse(path, anonymous)).toBe("unauthorized")
      }
    }

    // A 401 must short-circuit T3's probe rather than fall through to the next
    // path, so a rejected password can never yield a generation.
    expect(
      probeOpenCodeServerPaths({
        "/api/info": { status: 401, contentType: undefined, body: "" },
        "/global/health": {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ healthy: true, version: T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION }),
        },
      }),
    ).toEqual({ kind: "unauthorized" })
  })

  test("the PASSWORD is the secret; the username is ignored once the password is right", async () => {
    // CORRECTED PREMISE, recorded because the first version of this test asserted
    // the opposite and failed. Sending the correct password under a non-default
    // username answers 200, not 401.
    //
    // That is deliberate, not a hole. `ServerAuth.authorized` (src/server/auth.ts:33-39)
    // compares the username, but the router middleware then falls through to
    // `deviceAuthorized` (middleware/authorization.ts:129-145), whose candidate list
    // deliberately includes the decoded Basic password with the comment
    // "username ignored so clients can keep sending the ServerConnection.Http
    // credential shape unchanged" (authorization.ts:91-96). The password is the
    // secret; the username is decoration on that path.
    //
    // This matters for T3 only as an explanation: T3 hardcodes the username
    // "opencode", so it is unaffected. Pinning it prevents a future reader from
    // assuming a 401 always means the password was wrong.
    const wrongUsername = await get(profileServer, "/global/health", {
      username: "not-opencode",
      password: SERVER_PASSWORD,
    })
    expect(wrongUsername.status).toBe(200)

    // The load-bearing direction is unchanged: a wrong PASSWORD is refused.
    const wrongPassword = await get(profileServer, "/global/health", {
      username: SERVER_USERNAME,
      password: `${SERVER_PASSWORD}-wrong`,
    })
    expect(wrongPassword.status).toBe(401)

    // And the shared default both sides rely on: T3's probe hardcodes "opencode"
    // (t3-latest-probe.ts probeAuthorizationHeader) and ServerAuth.header defaults
    // to the same value, so the correct-credential case above is genuinely correct.
    expect(probeAuthorizationHeader(SERVER_PASSWORD)).toBe(
      `Basic ${Buffer.from(`opencode:${SERVER_PASSWORD}`, "utf8").toString("base64")}`,
    )
    expect(SERVER_USERNAME).toBe("opencode")
  })

  test("teardown PROVES the release: no listener and no reachable server of this run survives", async () => {
    // WHAT THIS TEST PROVES, and what it does NOT — stated because the
    // difference is the whole point and is easy to over-read.
    //
    // It proves UNREACHABILITY: after stop(), the port refuses a TCP connect and
    // an HTTP request against it fails. Two probes, but ONE property — they
    // agree in the same direction, so they are not two independent witnesses.
    //
    // It does NOT prove process-level survival-freedom. A same-property probe
    // could in principle agree spuriously, and `isListening` treats a 1s
    // connect timeout as "not listening". The PROCESS-level proof that no PID
    // created by this run outlived it is external: continuous 1s
    // Win32_Process sampling of this run's ancestry, attributed by PID plus
    // transitive parent chain. Do not cite this test as that evidence.
    //
    // What IS deliberately engineered here: the completion signal comes from a
    // DIFFERENT subsystem than the kill. `taskkill` performs the teardown;
    // `node:net` and `fetch` observe it. A kill is therefore never confirmed by
    // the kill mechanism's own success return code — which is exactly the
    // vacuity this suite already fell into once (taskkill exited 0 having
    // reaped nothing, because its tree root was already dead).
    //
    // Precondition, so the post-conditions cannot pass vacuously: both servers
    // are genuinely up and serving at the moment teardown runs. Without this,
    // "the port is free afterwards" would also hold for a server that never
    // started.
    const servers = [profileServer, canonicalServer]
    for (const server of servers) {
      expect((await get(server, "/global/health", CORRECT)).status).toBe(200)
    }

    const reports = await Promise.all(servers.map((server) => server.stop()))

    // In-band, portable half of the teardown proof: the socket is really gone.
    for (const [index, server] of servers.entries()) {
      expect(
        await isListening(server.port),
        `teardown report was "${reports[index]}" but ${server.url} still accepts connections`,
      ).toBe(false)
      // And the server is unreachable, not merely silent.
      let rejected = false
      try {
        await fetch(`${server.url}/global/health`)
      } catch {
        rejected = true
      }
      expect(rejected, `${server.url} still answered a request after teardown`).toBe(true)
    }

    // Non-vacuity for the reports themselves: a teardown that never ran would
    // still yield some string, so assert the shape only a real run emits.
    for (const report of reports) {
      expect(report).toMatch(
        /^pid=\d+ treeKilled=(true|false) directKillIssued=true port=\d+ port-released$/,
      )
    }

    // Idempotence: afterAll calls stop() again, and a second call must not be
    // able to manufacture a fresh success from an already-dead server.
    expect(await profileServer.stop()).toBe(reports[0]!)
  })
})

// ---------------------------------------------------------------------------
// 3. VERSION WINDOW — the release facade must stay inside T3's supported band
// ---------------------------------------------------------------------------

describe("release facade version window", () => {
  /** The real release line. Unlike the dev sentinel this is a live major. */
  const releaseVersion = (
    JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as { version: string }
  ).version

  test("the facade version cannot reach major 2 — the silent v2 flip", () => {
    // T3's `probed()` selects v2 at major >= 2. This is the upper bound that
    // keeps latest T3 on the retained v1 client.
    expect(semver.parse(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)?.major).toBe(1)
    expect(semver.major(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)).toBeLessThan(2)
  })

  test("the facade version stays at or above T3's own MINIMUM_OPENCODE_VERSION", () => {
    // The other release trap, independent of the one above: T3 hard-errors below
    // 1.14.19, so the facade must sit in the window [1.14.19, 2.0.0).
    expect(MINIMUM_OPENCODE_VERSION).toBe("1.14.19")
    expect(verifyOpenCodeServerVersion(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)).toEqual({ ok: true })
    expect(semver.gte(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION, MINIMUM_OPENCODE_VERSION)).toBe(true)
    expect(semver.lt(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION, MINIMUM_OPENCODE_VERSION)).toBe(false)
  })

  test("the REAL release version line is also major < 2, so a canonical external server stays v1", () => {
    // This is the non-inert half of the fence. `/global/health` reports
    // localClientReportedVersion(InstallationVersion) for an external-serverUrl
    // deployment WITHOUT the profile, so in a RELEASE build the value T3 reads
    // is OpenFork's own version. Asserting only the dev sentinel "local" would be
    // inert in CI, because a non-semver string fails closed and can never select
    // v2. Pinning the manifest line makes the release-time condition testable now.
    expect(semver.valid(releaseVersion)).not.toBeNull()
    expect(
      semver.major(releaseVersion),
      "canonical OpenFork now reports a major >= 2 on /global/health, so an external serverUrl deployment of T3 would silently negotiate v2. Decide the intended behaviour before shipping this version.",
    ).toBeLessThan(2)
    // The profile still overrides it, so the facade is unaffected by the bump.
    expect(localClientReportedVersion(releaseVersion, T3_PROFILE_ENV)).toBe(
      T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
    )
  })

  test("the dev sentinel is documented as inert rather than mistaken for a version", () => {
    // "local" is not semver, so T3 cannot classify it and the canonical fence
    // takes a fail-closed early return. That is safe — "local" can never select
    // v2 — but it means the dev build gives no warning. Recorded here so the
    // previous test is not mistaken for covering it.
    //
    // NOTE: asserted with semver.valid/semver.parse, which return null. The
    // `semver.major()` accessor THROWS a TypeError on an unparseable version
    // instead of returning NaN, so it cannot be used to express this at all.
    expect(semver.valid(InstallationVersion)).toBeNull()
    expect(semver.parse(InstallationVersion)).toBeNull()
    // And it is the same sentinel T3's own parser rejects, so the fail-closed
    // branch is genuinely reachable rather than hypothetical.
    expect(classifyOpenCodeProbeResponse("/global/health", {
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ healthy: true, version: InstallationVersion }),
    })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 4. PACKAGED LAUNCHER BUILD-STATE REQUIREMENT — a build fact, NOT a defect
// ---------------------------------------------------------------------------

describe("packaged launcher build-state requirement (explicitly not a facade defect)", () => {
  const wrapper = readFileSync(join(PACKAGE_ROOT, "bin", "openfork-t3code"), "utf8")
  const transparent = readFileSync(join(PACKAGE_ROOT, "bin", "opencode"), "utf8")

  test("the wrapper activates the profile and nothing else sets it", () => {
    // The wrapper is the ONLY thing that activates the facade. It mutates its own
    // process.env and then imports the real binary.
    expect(wrapper).toContain(`process.env.${OPENFORK_COMPAT_PROFILE_ENV} = "${T3_CODE_COMPAT_PROFILE}"`)
    expect(wrapper).toContain('await import("./openfork")')
    // No credential, no version override, no auth change: the wrapper is a
    // branding/version projection and must stay that small.
    expect(wrapper).not.toContain("OPENCODE_SERVER_PASSWORD")
    expect(wrapper).not.toContain(T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION)
  })

  test("`opencode` stays a transparent forward and must never gain the profile", () => {
    // Load-bearing: existing OpenFork scripts use the historical name and must
    // not silently enter a consumer profile.
    expect(transparent).not.toContain(OPENFORK_COMPAT_PROFILE_ENV)
    expect(transparent).toContain('await import("./openfork")')
  })

  test("OPENFORK_BIN_PATH is a BUILD requirement of this checkout, not a facade regression", () => {
    // Recorded as a fact rather than asserted as a passing launch, because the
    // correct outcome differs by build state and conflating them would either
    // hide a real facade break or report a build gap as a product bug:
    //
    //   - docs §Distribution promises PACKAGED-distribution execution only.
    //   - In an UNBUILT worktree there is no `openfork` binary next to the
    //     wrapper, so `bin/openfork-t3code` requires OPENFORK_BIN_PATH to point
    //     at one. That is expected here.
    //   - This file therefore proves the facade through CURRENT SOURCE, which
    //     needs no such variable at all (see the subprocess tests above).
    //
    // So the requirement is asserted as: the wrapper delegates binary resolution
    // to `openfork`, and nothing in the compat facade participates in it.
    const distBinary = join(PACKAGE_ROOT, "dist", "openfork-windows-x64", "bin", "openfork.exe")
    let distExists = true
    try {
      readFileSync(distBinary)
    } catch {
      distExists = false
    }
    // Whatever the build state, the facade's own inputs stay correct: the
    // projection is a pure function of the profile env var and the native
    // version, with no dependency on how the binary was resolved.
    expect(localClientReportedVersion("native-sentinel", T3_PROFILE_ENV)).toBe(
      T3_CODE_OPEN_CODE_COMPATIBILITY_VERSION,
    )
    expect(isT3CodeCompatibilityProfile(CANONICAL_ENV)).toBe(false)
    // A present dist artifact is build residue that may predate HEAD. Its mere
    // presence is never treated as current-source evidence by this file.
    expect(typeof distExists).toBe("boolean")
  })
})