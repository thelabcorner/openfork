/**
 * WakaTime process-global fixture.
 *
 * `WakaTime.node` is a deliberate process singleton: the first layer build in a
 * process installs the only CodingActivity consumer and owns the only coalescing
 * queue. That is exactly the behavior under test, and it is also why it cannot
 * be exercised in-process — a second test in the same Bun test worker would
 * inherit the first test's runtime and its captured dependencies.
 *
 * So every service-level scenario runs here, in a fresh child process, where the
 * module-global state is naturally clean. The parent test spawns this file once
 * per scenario and asserts on the exit code and the result marker.
 *
 * Run directly: `bun test/fixture/wakatime-process.fixture.ts <scenario>`
 */

import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodingActivity } from "@opencode-ai/core/coding-activity"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import * as LayerNodePlatform from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { AppProcess, AppProcessError } from "@opencode-ai/core/process"
import { WakaTime } from "@opencode-ai/core/wakatime"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"

export const RESULT_MARKER = "WAKATIME_FIXTURE_RESULT "
const VALID_MANAGED_FIXTURE = Buffer.alloc(1_048_576, 0x41)

// This fixture is documented as directly runnable, so it cannot rely on the
// parent test's XDG_CACHE_HOME override. Redirect the managed CLI target before
// any scenario can write a fake binary; otherwise the system-CLI precedence
// case can overwrite the developer's real ~/.cache/openfork/bin/wakatime-cli.
const fixtureCache = await mkdtemp(path.join(os.tmpdir(), "openfork-wakatime-fixture-cache-"))
Global.Path.bin = path.join(fixtureCache, "bin")
await mkdir(Global.Path.bin, { recursive: true })

interface Invocation {
  readonly binary: string
  readonly args: readonly string[]
  readonly stdin?: string
  readonly cwd?: string
  readonly at: number
}

let invocations: Invocation[] = []

/**
 * When set, the fake CLI holds every spawn open until the Deferred completes.
 * This is what makes queue-mutex ownership observable: a real spawn can block,
 * and the queue has to stay usable while it does.
 */
let spawnHold: Deferred.Deferred<void> | undefined
let spawnExitCode = 0
let spawnFailure: AppProcessError | undefined

const processNode = makeGlobalNode({
  service: AppProcess.Service,
  layer: Layer.mock(AppProcess.Service, {
    run: (command, options) =>
      Effect.suspend(() => {
        if (command._tag !== "StandardCommand") throw new Error("WakaTime must spawn a standard command")
        invocations.push({
          binary: command.command,
          args: command.args,
          ...(options?.stdin === undefined ? {} : { stdin: String(options.stdin) }),
          ...(command.options.cwd === undefined ? {} : { cwd: String(command.options.cwd) }),
          at: Date.now(),
        })
        return Effect.gen(function* () {
          if (spawnHold) yield* Deferred.await(spawnHold)
          if (spawnFailure) return yield* Effect.fail(spawnFailure)
          return {
            command: command.command,
            exitCode: spawnExitCode,
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            stdoutTruncated: false,
            stderrTruncated: false,
          }
        })
      }),
  }),
  deps: [],
})

const build = () => AppNodeBuilder.build(LayerNode.group([WakaTime.node]), [[AppProcess.node, processNode]])

/**
 * The same graph with the HTTP boundary replaced, so the managed-CLI update path
 * can be driven deterministically without touching the network. Everything else
 * — the queue, the limiter, the persistence, the atomic replace — is the real
 * implementation.
 */
const managedBuild = () =>
  AppNodeBuilder.build(LayerNode.group([WakaTime.node]), [
    [AppProcess.node, processNode],
    [LayerNodePlatform.httpClient, Layer.succeed(HttpClient.HttpClient, managedHttp)],
  ])

/**
 * Build one independent graph into a scope the caller owns and extract the
 * service from the built Context. `Layer.buildWithScope` is the repo pattern for
 * a graph with a controllable lifetime (see test/question.test.ts): `Effect.provide`
 * closes the layer's own scope as soon as the provided effect returns, so it
 * cannot express two graphs whose lifetimes overlap.
 */
const buildInto = (scope: Scope.Closeable, make: typeof build = build) =>
  Effect.map(Layer.buildWithScope(Layer.fresh(make()), scope), (context) => Context.get(context, WakaTime.Service))

/**
 * Build one graph into a scope this call owns, run the body against the live
 * service, then close that graph's scope. Only `WakaTime.Service` is exported by
 * the compiled graph — `CodingActivity` is a dependency of it, so tests publish
 * through the module-level `CodingActivity.record`, which writes to the same
 * process bus.
 */
function withService<A, E>(body: (wakatime: WakaTime.Interface) => Effect.Effect<A, E>) {
  return Effect.gen(function* () {
    const scope = yield* Scope.make()
    const wakatime = yield* buildInto(scope)
    return yield* body(wakatime).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
  })
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function equal<T>(actual: T, expected: T, message: string) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${message}\n  actual:   ${a}\n  expected: ${b}`)
}

function argValue(args: readonly string[], flag: string) {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

async function cliFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openfork-wakatime-"))
  const binary = path.join(dir, "wakatime-cli")
  await writeFile(binary, "managed-binary-placeholder")
  process.env.OPENFORK_WAKATIME_CLI = binary
  return binary
}

/**
 * A stored-only release archive plus the published checksum manifest for it,
 * mirroring the shapes the real download path consumes. The digest is computed
 * over the exact bytes served, so a normal check verifies and a corrupted
 * response fails closed.
 */
const RELEASE_BYTES = "managed-wakatime-release-binary"

function releaseAsset() {
  const arch =
    process.arch === "x64"
      ? "amd64"
      : process.arch === "arm64"
        ? "arm64"
        : process.arch === "ia32"
          ? "386"
          : undefined
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "darwin"
        : process.platform === "linux"
          ? "linux"
          : undefined
  if (!arch || !platform) return undefined
  const binary = `wakatime-cli-${platform}-${arch}${platform === "windows" ? ".exe" : ""}`
  return { binary, archive: `${binary.replace(/\.exe$/, "")}.zip` }
}

function storedZip(name: string, data: Uint8Array) {
  const encoded = new TextEncoder().encode(name)
  const local = new Uint8Array(30 + encoded.length + data.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint32(18, data.length, true)
  lv.setUint32(22, data.length, true)
  lv.setUint16(26, encoded.length, true)
  local.set(encoded, 30)
  local.set(data, 30 + encoded.length)

  const central = new Uint8Array(46 + encoded.length)
  const cv = new DataView(central.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(4, 20, true)
  cv.setUint16(6, 20, true)
  cv.setUint32(20, data.length, true)
  cv.setUint32(24, data.length, true)
  cv.setUint16(28, encoded.length, true)
  cv.setUint32(42, 0, true)
  central.set(encoded, 46)

  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, central.length, true)
  ev.setUint32(16, local.length, true)

  const out = new Uint8Array(local.length + central.length + eocd.length)
  out.set(local, 0)
  out.set(central, local.length)
  out.set(eocd, local.length + central.length)
  return out
}

let servedVersion = "1.4.0"
let servedArchiveChecksum = ""
let versionFetches = 0
let archiveFetches = 0
/** Every asset URL the run requested, so a test can assert which release they addressed. */
let assetUrls: string[] = []
/**
 * How the fake archive response is shaped. "declared-oversize" announces a body
 * larger than the limit; "chunked-oversize" announces nothing and streams past
 * the limit so the collector has to abandon it partway.
 */
let assetBodyMode: "bytes" | "declared-oversize" | "chunked-oversize" = "bytes"
const CHUNK_SIZE = 1024 * 1024
let chunksServed = 0
let chunksTotal = 0

function archiveResponse(asset: { readonly binary: string }) {
  const bytes = storedZip(asset.binary, new TextEncoder().encode(RELEASE_BYTES))
  if (assetBodyMode === "declared-oversize") {
    // A stream body keeps the explicit header: a buffered body would have its
    // Content-Length recomputed by the runtime.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes)
        controller.close()
      },
    })
    return new Response(stream, { headers: { "content-length": String(WakaTime.MAX_ARCHIVE_BYTES + 1) } })
  }
  if (assetBodyMode === "chunked-oversize") {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunksServed >= chunksTotal) {
          controller.close()
          return
        }
        chunksServed++
        controller.enqueue(new Uint8Array(CHUNK_SIZE))
      },
    })
    return new Response(stream, { headers: { "content-type": "application/zip" } })
  }
  return new Response(bytes)
}
/** Models a newer release publishing between the metadata fetch and the asset fetches. */
let advanceOnMetadata = false

const managedHttp = HttpClient.make((request) =>
  Effect.suspend(() => {
    if (request.url.includes("checksums_sha256.txt")) {
      assetUrls.push(request.url)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(servedArchiveChecksum, { status: 200 })))
    }
    if (request.url.endsWith(".zip")) {
      assetUrls.push(request.url)
      archiveFetches++
      return Effect.succeed(HttpClientResponse.fromWeb(request, archiveResponse(releaseAsset()!)))
    }
    versionFetches++
    const tag = `v${servedVersion}`
    // The pointer moves the instant the metadata is read, which is exactly the
    // window in which a `/releases/latest/download` install would mix releases.
    if (advanceOnMetadata) servedVersion = "1.5.1"
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify({ tag_name: tag }), { status: 200 })),
    )
  }),
)

/**
 * Assert every asset URL requested since the last check addressed one exact tag,
 * and never the moving `latest` pointer. Consumes the list.
 */
function pinnedTo(tag: string) {
  for (const url of assetUrls) {
    assert(url.includes(`/releases/download/${tag}/`), `asset URL must stay pinned to ${tag}: ${url}`)
    assert(!url.includes("/releases/latest/"), `asset URL must not follow the latest pointer: ${url}`)
  }
  assetUrls = []
}

const writeState = (target: string, value: Record<string, unknown>) =>
  Effect.promise(() => writeFile(target, `${JSON.stringify(value)}\n`))

/**
 * Reset every managed-CLI precondition: no override, nothing named
 * wakatime-cli reachable on PATH, and a checksum manifest that matches the
 * bytes actually served. The cache directory is already isolated per run, so the
 * managed binary is the only thing Core can resolve.
 */
async function managedHome(corrupt = false) {
  delete process.env.OPENFORK_WAKATIME_CLI
  process.env.PATH = ""
  servedVersion = "1.4.0"
  versionFetches = 0
  archiveFetches = 0
  assetUrls = []
  advanceOnMetadata = false
  assetBodyMode = "bytes"
  chunksServed = 0
  chunksTotal = 0
  const asset = releaseAsset()
  if (!asset) return undefined
  const archive = storedZip(asset.binary, new TextEncoder().encode(RELEASE_BYTES))
  servedArchiveChecksum = corrupt
    ? `${"0".repeat(64)}  ${asset.archive}\n`
    : `${createHash("sha256").update(archive).digest("hex")}  ${asset.archive}\n`
  return {
    // The installed target is the fixed managed name; the archive entry inside
    // the release is the per-platform asset name.
    binary: path.join(Global.Path.bin, process.platform === "win32" ? "wakatime-cli.exe" : "wakatime-cli"),
    state: WakaTime.cliStateFile(),
    asset,
  }
}

const readText = (target: string) => Effect.promise(() => readFile(target, "utf8"))

async function emptyWakaTimeHome() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openfork-wakatime-home-"))
  process.env.WAKATIME_HOME = dir
  return dir
}

function optIn() {
  process.env.OPENFORK_WAKATIME = "1"
  process.env.WAKATIME_API_KEY = "key"
}

/**
 * Credentials only, with no env opt-in, so the persisted Core setting is the
 * effective opt-in. Used where the scenario is specifically about the persisted
 * checkbox rather than the env override.
 */
function optInPersisted() {
  delete process.env.OPENFORK_WAKATIME
  process.env.WAKATIME_API_KEY = "key"
}

/** The CodingActivity consumer is forked into the process scope; let it drain. */
const settle = Effect.gen(function* () {
  for (let index = 0; index < 16; index++) yield* Effect.yieldNow
})

/**
 * Wait for the exporter's own debounce window to deliver, without a manual
 * flush. Returns false when nothing arrived, which is how a scenario proves a
 * timer was never armed rather than merely firing late.
 */
const waitFor = Effect.fnUntraced(function* (ready: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (!ready()) {
    if (Date.now() > deadline) return false
    yield* Effect.sleep(50)
  }
  return true
})

const waitForDelivery = (timeoutMs: number) => waitFor(() => invocations.length > 0, timeoutMs)

const scenarios: Record<string, () => Promise<unknown>> = {
  "opt-in-default-off": async () => {
    // Control both credential sources so the scenario does not inherit a real
    // ~/.wakatime.cfg from the host.
    await emptyWakaTimeHome()
    const binary = await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          equal(
            yield* wakatime.status(),
            { enabled: false, configured: false },
            "an absent toggle must be disabled and unconfigured",
          )

          // A key and a resolvable CLI are configuration, not consent.
          process.env.WAKATIME_API_KEY = "key"
          yield* wakatime.record({ entity: "/repo/a.ts" })
          yield* CodingActivity.record({ entity: "/repo/b.ts", kind: "write", source: "core" })
          yield* settle
          yield* wakatime.flush()

          equal(invocations, [], "a disabled exporter must never spawn the CLI")
          return { binary }
        }),
      ),
    )
  },

  "opt-in-explicit": () =>
    Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          process.env.WAKATIME_API_KEY = "key"

          equal(
            yield* wakatime.status(),
            { enabled: false, configured: true },
            "an API key is configuration, not consent",
          )

          process.env.OPENFORK_WAKATIME = "no"
          equal(
            yield* wakatime.status(),
            { enabled: false, configured: true },
            "an explicit false toggle must stay off",
          )

          process.env.OPENFORK_WAKATIME = "1"
          const status = yield* wakatime.status()
          assert(status.enabled, "an explicit true toggle must enable the exporter")
          return { enabled: status.enabled }
        }),
      ),
    ),

  unconfigured: async () => {
    await emptyWakaTimeHome()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          process.env.OPENFORK_WAKATIME = "true"
          equal(
            yield* wakatime.status(),
            { enabled: true, configured: false },
            "opted in without credentials must report unconfigured",
          )
        }),
      ),
    )
  },

  "status-no-download": () =>
    Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          process.env.OPENFORK_WAKATIME_CLI = path.join(os.tmpdir(), "openfork-wakatime-absent", "wakatime-cli")

          equal(
            yield* wakatime.status(),
            { enabled: true, configured: true },
            "an unresolvable override must degrade to no cli, never to a download",
          )
          equal(invocations, [], "status must not spawn anything")
        }),
      ),
    ),

  batching: async () => {
    const binary = await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* wakatime.record([
            { entity: "/repo/a.ts", isWrite: true, time: 1_700_000_000_000 },
            { entity: "/repo/b.ts", time: 1_700_000_001_000 },
          ])
          yield* wakatime.flush()

          equal(invocations.length, 1, "one coalescing window must produce exactly one CLI invocation")
          const [invocation] = invocations
          equal(invocation!.binary, binary, "the resolved override binary must be invoked")
          equal(argValue(invocation!.args, "--entity"), "/repo/a.ts", "the leading heartbeat must keep its entity")
          equal(argValue(invocation!.args, "--entity-type"), "file", "WakaTime activity must use file entities")
          equal(argValue(invocation!.args, "--category"), "ai coding", "WakaTime activity must use the AI coding category")
          equal(argValue(invocation!.args, "--time"), "1700000000", "the leading heartbeat must use observation time")
          assert(invocation!.args.includes("--write"), "a created/written leading entity must carry --write")
          assert(invocation!.args.includes("--sync-ai-disabled"), "OpenFork must prevent CLI-side AI transcript double counting")
          const plugin = argValue(invocation!.args, "--plugin")
          assert(plugin?.startsWith("openfork/"), "the actual native heartbeat argv must identify OpenFork")
          assert(invocation!.args.includes("--extra-heartbeats"), "a batch must request extra heartbeats")
          const extras = JSON.parse(invocation!.stdin!.trim()) as Array<{
            entity: string
            entity_type: string
            category: string
            time: number
            is_write?: boolean
          }>
          equal(extras.length, 1, "the batch must carry every non-leading heartbeat")
          equal(extras[0]!.entity, "/repo/b.ts", "the trailing heartbeat must keep its entity")
          equal(extras[0]!.entity_type, "file", "extra heartbeats must preserve file entity semantics")
          equal(extras[0]!.category, "ai coding", "extra heartbeats must preserve the AI coding category")
          equal(extras[0]!.time, 1_700_000_001, "millis must lower back to CLI seconds")
          equal(extras[0]!.is_write, undefined, "a read-only trailing heartbeat must omit the write field")
          return { invocations: invocations.length }
        }),
      ),
    )
  },

  "coalesce-merge": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* wakatime.record({ entity: "/repo/a.ts", aiLineChanges: 3, time: 1_700_000_000_000 })
          yield* wakatime.record({
            entity: "/repo/a.ts",
            aiLineChanges: 4,
            isWrite: true,
            time: 1_700_000_005_000,
          })
          yield* wakatime.flush()

          equal(invocations.length, 1, "repeated observations of one entity must coalesce")
          const args = invocations[0]!.args
          assert(!args.includes("--extra-heartbeats"), "a coalesced entity is not an extra heartbeat")
          equal(argValue(args, "--ai-line-changes"), "7", "line changes must accumulate")
          equal(argValue(args, "--time"), "1700000005", "the newest observation must win the timestamp")
          assert(args.includes("--write"), "write state must be sticky across a coalescing window")
        }),
      ),
    )
  },

  /**
   * AI line changes are signed NET deltas (additions minus deletions). A
   * rewrite that removes more than it adds is a real negative delta and has to
   * survive both the coalescing merge and the wire, and an exactly-zero net
   * carries no information so it is omitted rather than clamped.
   */
  "signed-deltas": async () => {
    const binary = await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()

          // Arithmetic merge of two negative observations inside one window.
          yield* wakatime.record({ entity: "/repo/net.ts", aiLineChanges: -3, time: 1_700_000_000_000 })
          yield* wakatime.record({ entity: "/repo/net.ts", aiLineChanges: -4, time: 1_700_000_001_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "one coalescing window must produce one spawn")
          equal(argValue(invocations[0]!.args, "--ai-line-changes"), "-7", "signed deltas must merge arithmetically")
          equal(invocations[0]!.binary, binary, "the resolved override binary must be invoked")

          // A negative net that follows a positive one in a LATER window is
          // still reported as a negative: a clamp here would report the
          // deletion as "no change".
          invocations = []
          yield* wakatime.record({ entity: "/repo/rewrite.ts", aiLineChanges: 6, time: 1_700_000_002_000 })
          yield* wakatime.flush()
          yield* wakatime.record({ entity: "/repo/rewrite.ts", aiLineChanges: -9, time: 1_700_000_003_000 })
          yield* wakatime.flush()
          equal(invocations.length, 2, "each window must still be delivered")
          equal(argValue(invocations[1]!.args, "--ai-line-changes"), "-9", "a negative net must reach the CLI as negative")

          // A signed delta that exactly cancels out has nothing to report, so
          // the flag is omitted instead of being sent or clamped.
          invocations = []
          yield* wakatime.record({ entity: "/repo/zero.ts", aiLineChanges: 5, time: 1_700_000_004_000 })
          yield* wakatime.record({ entity: "/repo/zero.ts", aiLineChanges: -5, time: 1_700_000_005_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "a cancelled window must still be delivered")
          assert(
            !invocations[0]!.args.includes("--ai-line-changes"),
            "a net of exactly zero must be omitted, never clamped to a reported zero",
          )

          // The same rule applies to the extra-heartbeat payload.
          invocations = []
          yield* wakatime.record({ entity: "/repo/lead.ts", aiLineChanges: 1, time: 1_700_000_006_000 })
          yield* wakatime.record({ entity: "/repo/trailing.ts", aiLineChanges: -12, time: 1_700_000_007_000 })
          yield* wakatime.flush()
          const extras = JSON.parse(invocations[0]!.stdin!.trim()) as Array<Record<string, unknown>>
          equal(extras[0]!.entity, "/repo/trailing.ts", "the trailing heartbeat must keep its entity")
          equal(extras[0]!.ai_line_changes, -12, "a negative net must survive into the extra-heartbeat payload")
          return { delivered: invocations.length }
        }),
      ),
    )
  },

  /**
   * A canonical project folder the producer actually observed becomes
   * --project-folder, and the internal routing metadata that scopes selective
   * flush and replay suppression stops at the Core boundary.
   */
  "project-folder": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* CodingActivity.record({
            entity: "/repo/src/index.ts",
            kind: "write",
            time: 1_700_000_000,
            project: "openfork",
            projectFolder: "/repo",
            aiSession: "ses_folder",
            sourceRef: "call_01",
            source: "session",
          })
          yield* CodingActivity.record({
            entity: "/repo/src/other.ts",
            kind: "read",
            time: 1_700_000_001,
            project: "openfork",
            projectFolder: "/repo",
            aiSession: "ses_folder",
            source: "session",
          })
          yield* settle
          yield* wakatime.flush()

          equal(invocations.length, 1, "both observations must coalesce into one spawn")
          const args = invocations[0]!.args
          equal(argValue(args, "--project-folder"), "/repo", "a proven project folder must be forwarded verbatim")
          equal(invocations[0]!.cwd, "/repo", "a proven project folder must also own the CLI working directory")
          const extras = JSON.parse(invocations[0]!.stdin!.trim()) as Array<Record<string, unknown>>
          equal(extras[0]!.entity, "/repo/src/other.ts", "a trailing heartbeat must keep its entity")
          // An extra heartbeat must not be able to rename or re-route WakaTime's
          // own project detection, so it carries no project field at all. The
          // invocation's --project-folder and working directory are the only
          // project identity on the wire.
          for (const forbidden of ["alternate_project", "project", "project_folder"]) {
            assert(!(forbidden in extras[0]!), `an extra heartbeat must not carry ${forbidden}`)
          }

          // Internal routing metadata exists for Core's own queue decisions and
          // has no wakatime-cli field, so it must never be serialized.
          const wire = `${args.join(" ")} ${invocations[0]!.stdin ?? ""}`
          for (const leaked of ["ses_folder", "call_01", "sourceRef", "aiSession"]) {
            assert(!wire.includes(leaked), `internal metadata ${leaked} must never reach wakatime-cli`)
          }

          invocations = []
          yield* wakatime.record({ entity: "/unscoped/file.ts", time: 1_700_000_002_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "an unscoped observation must still be deliverable")
          assert(
            !invocations[0]!.args.includes("--project-folder"),
            "an unproven project folder must never be invented on the CLI argv",
          )
          equal(
            invocations[0]!.cwd,
            WakaTime.neutralCwd(),
            "an unscoped observation must run from a neutral root instead of inheriting OpenFork's cwd",
          )
          return { projectFolder: argValue(args, "--project-folder") }
        }),
      ),
    )
  },

  /**
   * Replay suppression is bounded and only ever applies to records carrying an
   * authoritative producer reference. Because it runs at enqueue, it catches a
   * replay that lands in a later debounce window than the original.
   */
  "replay-dedupe": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const authoritative = {
            entity: "/repo/authoritative.ts",
            aiSession: "ses_replay",
            source: "session" as const,
            replayToken: "call_01",
            kind: "write" as const,
            isWrite: true,
          }

          yield* wakatime.record({ ...authoritative, time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the first authoritative observation must be delivered")

          // The same token replayed in a LATER window, after the queue was
          // already emptied, is the same event and must be suppressed.
          yield* wakatime.record({ ...authoritative, time: 1_700_000_005_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "a replay across debounce windows must be suppressed")

          // A different replay token in the same window is a different event.
          yield* wakatime.record({ ...authoritative, replayToken: "call_02", time: 1_700_000_006_000 })
          yield* wakatime.flush()
          equal(invocations.length, 2, "a distinct authoritative replay token must not be suppressed")

          // Without an authoritative replay token there is no proof of a replay,
          // so an honest repeat is always kept.
          const unproven = { entity: "/repo/unproven.ts", aiSession: "ses_replay", source: "session" as const }
          yield* wakatime.record({ ...unproven, time: 1_700_000_007_000 })
          yield* wakatime.flush()
          yield* wakatime.record({ ...unproven, time: 1_700_000_008_000 })
          yield* wakatime.flush()
          equal(invocations.length, 4, "records without an authoritative replay token must never be deduped")

          // Suppression is scoped per session, so the same replay token observed by
          // another session is a different event.
          yield* wakatime.record({ ...authoritative, aiSession: "ses_other", time: 1_700_000_009_000 })
          yield* wakatime.flush()
          equal(invocations.length, 5, "the same replay token in another session must not be suppressed")
          return { delivered: invocations.length }
        }),
      ),
    )
  },

  /**
   * `sourceRef` is actor attribution, not idempotency. OFXP deliberately keeps
   * one stable principal key across calls, so two real edits by that same peer
   * to the same file must both survive unless a per-invocation replayToken says
   * they are the same logical observation.
   */
  "principal-source-ref-not-replay-token": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const principal = {
            entity: "/repo/remote.ts",
            source: "ofxp" as const,
            sourceRef: "ofxp:peer:stable-principal",
            kind: "write" as const,
            isWrite: true,
          }

          yield* wakatime.record({ ...principal, aiLineChanges: 2, time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the peer's first real observation must be delivered")

          yield* wakatime.record({ ...principal, aiLineChanges: 3, time: 1_700_000_001_000 })
          yield* wakatime.flush()
          equal(invocations.length, 2, "stable principal identity must not suppress a later real edit")
          equal(
            argValue(invocations[1]!.args, "--ai-line-changes"),
            "3",
            "the peer's later edit must retain its own line-change delta",
          )

          const replayable = { ...principal, replayToken: "invocation_exact", aiLineChanges: 4 }
          yield* wakatime.record({ ...replayable, time: 1_700_000_002_000 })
          yield* wakatime.flush()
          equal(invocations.length, 3, "the first observation carrying a replay token must be delivered")
          yield* wakatime.record({ ...replayable, time: 1_700_000_003_000 })
          yield* wakatime.flush()
          equal(invocations.length, 3, "the same per-invocation replay token must suppress a true replay")
          return { delivered: invocations.length }
        }),
      ),
    )
  },

  /**
   * A session-selective flush delivers exactly one session's queued work and
   * leaves every other session queued, including on its own coalescing window.
   */
  "flush-session": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* wakatime.record({ entity: "/repo/a.ts", aiSession: "ses_a", time: 1_700_000_000_000 })
          yield* wakatime.record({ entity: "/repo/b.ts", aiSession: "ses_b", time: 1_700_000_001_000 })
          yield* wakatime.flushSession("ses_a")

          equal(invocations.length, 1, "only the selected session may be delivered")
          equal(
            argValue(invocations[0]!.args, "--entity"),
            "/repo/a.ts",
            "the selected session's observation must be the delivered one",
          )
          assert(!invocations[0]!.args.includes("--extra-heartbeats"), "another session's work must not ride along")

          // The other session is still queued, and the shared window was left
          // armed rather than cancelled.
          yield* wakatime.flush()
          equal(invocations.length, 2, "the other session must still be queued after a session flush")
          equal(argValue(invocations[1]!.args, "--entity"), "/repo/b.ts", "the other session's work must survive")

          // The shared window alone fires. Because the project is now inside its
          // 60s delivery window it holds the new work rather than dropping it —
          // a cancelled per-session timer would have stranded that work with
          // nothing left to deliver it.
          yield* wakatime.record({ entity: "/repo/c.ts", aiSession: "ses_c", time: 1_700_000_002_000 })
          yield* Effect.sleep(3_000)
          equal(invocations.length, 2, "the limiter must hold the new work instead of spawning again")

          // ...and a forced flush retrieves exactly what the window held.
          yield* wakatime.flush()
          equal(invocations.length, 3, "the held observation must still be queued and deliverable")
          equal(argValue(invocations[2]!.args, "--entity"), "/repo/c.ts", "the surviving window's work must survive the hold")

          // A blank selector names no session and must neither deliver nor
          // discard anything.
          invocations = []
          yield* wakatime.record({ entity: "/repo/d.ts", time: 1_700_000_003_000 })
          yield* wakatime.flushSession("   ")
          equal(invocations, [], "a blank session selector must deliver nothing")
          yield* wakatime.flush()
          equal(invocations.length, 1, "a blank session flush must not discard queued work")
          equal(argValue(invocations[0]!.args, "--entity"), "/repo/d.ts", "the unowned observation must survive a blank selector")
          return { delivered: invocations.length }
        }),
      ),
    )
  },

  /**
   * A burst of edits must not turn into a burst of processes. The debounce still
   * coalesces at 1.5s, but the second window for the same project is held and
   * rescheduled rather than spawned — and an explicit session flush is still
   * honoured, because the caller asked.
   */
  "delivery-limiter": async () => {
    const binary = await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const session = "ses_limiter"

          // First window: the debounce fires and opens the project window.
          yield* wakatime.record({ entity: "/repo/first.ts", aiSession: session, time: 1_700_000_000_000 })
          assert(yield* waitForDelivery(8_000), "the first window must deliver through the debounce")
          equal(invocations.length, 1, "the first window must produce exactly one spawn")
          equal(invocations[0]!.binary, binary, "the resolved override binary must be invoked")

          // Second window for the same project: held, not spawned, not dropped.
          yield* wakatime.record({ entity: "/repo/second.ts", aiSession: session, time: 1_700_000_001_000 })
          yield* Effect.sleep(3_000)
          equal(
            invocations.length,
            1,
            "the delivery limiter must prevent a second CLI spawn for the same project",
          )

          // The held record was delayed, never discarded.
          yield* wakatime.flushSession(session)
          equal(invocations.length, 2, "a forced session flush must bypass the limiter")
          equal(
            argValue(invocations[1]!.args, "--entity"),
            "/repo/second.ts",
            "the held observation must still be queued when the limiter released it",
          )

          // The bypassed spawn consumed the window, so the next periodic window
          // is held again rather than immediately re-spawning.
          yield* wakatime.record({ entity: "/repo/third.ts", aiSession: session, time: 1_700_000_002_000 })
          yield* Effect.sleep(3_000)
          equal(invocations.length, 2, "a forced flush must also open the delivery window")
          return { spawned: invocations.length }
        }),
      ),
    )
  },

  /**
   * The official adapter persists the project heartbeat floor across process
   * restarts. Core keeps the same external behavior with one bounded hashed
   * state document: closing the last exporter lease and rebuilding it must not
   * buy the project a fresh automatic 60-second budget.
   */
  "delivery-limiter-restart-state": async () => {
    await cliFixture()
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()

        const firstScope = yield* Scope.make()
        const first = yield* buildInto(firstScope)
        yield* first.record({
          entity: "/repo/first.ts",
          projectFolder: "/repo/private-project",
          time: 1_700_000_000_000,
        })
        assert(yield* waitForDelivery(8_000), "the first exporter must deliver the project's first window")
        equal(invocations.length, 1, "the first exporter must produce exactly one CLI invocation")

        const persisted = yield* Effect.promise(() => Bun.file(WakaTime.deliveryStateFile()).text())
        assert(!persisted.includes("/repo/private-project"), "persisted limiter state must never expose the raw project path")
        assert(
          persisted.includes(WakaTime.deliveryWindowKey("/repo/private-project")),
          "persisted limiter state must contain the project's stable fingerprint",
        )

        yield* Scope.close(firstScope, Exit.void)

        const secondScope = yield* Scope.make()
        const second = yield* buildInto(secondScope)
        yield* second.record({
          entity: "/repo/second.ts",
          projectFolder: "/repo/private-project",
          time: 1_700_000_001_000,
        })
        yield* Effect.sleep(3_000)
        equal(invocations.length, 1, "a rebuilt exporter must honor the persisted project delivery window")

        yield* second.flush()
        equal(invocations.length, 2, "forced flush must recover the restart-held observation")
        equal(argValue(invocations[1]!.args, "--entity"), "/repo/second.ts", "restart-held work must not be dropped")

        yield* Scope.close(secondScope, Exit.void)
        return { invocations: invocations.length }
      }),
    )
  },

  /**
   * Managed-CLI freshness never turns a status read or an operator override
   * into a download, an install, or a network call. Only delivery that actually
   * needs a managed binary may check, and never more than once per 4h.
   */
  /**
   * A batch that spans two projects must never share one spawn: `--project-folder`
   * and the child working directory belong to the primary invocation and an extra
   * heartbeat inherits both, so one project's time would be filed under another
   * project's root.
   */
  "cross-project-batch": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* wakatime.record([
            { entity: "/alpha/a.ts", projectFolder: "/alpha", time: 1_700_000_000_000 },
            { entity: "/beta/b.ts", projectFolder: "/beta", time: 1_700_000_001_000 },
            { entity: "/alpha/c.ts", projectFolder: "/alpha", time: 1_700_000_002_000 },
          ])
          yield* wakatime.flush()

          equal(invocations.length, 2, "one batch spanning two projects must spawn once per project")
          const alpha = invocations.find((entry) => argValue(entry.args, "--project-folder") === "/alpha")
          const beta = invocations.find((entry) => argValue(entry.args, "--project-folder") === "/beta")
          assert(alpha !== undefined, "the alpha group must get its own primary invocation")
          assert(beta !== undefined, "the beta group must get its own primary invocation")
          equal(argValue(alpha.args, "--entity"), "/alpha/a.ts", "the alpha primary must be an alpha observation")
          equal(argValue(beta.args, "--entity"), "/beta/b.ts", "the beta primary must be a beta observation")

          const alphaExtras = JSON.parse(alpha.stdin!.trim()) as Array<{ entity: string }>
          equal(alphaExtras.length, 1, "the alpha group must carry only its own trailing heartbeat")
          equal(alphaExtras[0]!.entity, "/alpha/c.ts", "an extra heartbeat must stay inside its own project")
          assert(!alpha.stdin!.includes("/beta"), "a beta heartbeat must never ride in the alpha payload")
          assert(beta.stdin === undefined, "a single-heartbeat project must not open an extras pipe")
          return { spawns: invocations.length }
        }),
      ),
    )
  },

  /**
   * One WakaTime CLI invocation owns one plugin/User-Agent for its primary and
   * every stdin extra heartbeat. Native OpenFork, OXP, and OFXP activity in the
   * same project must therefore remain three attribution groups even when two
   * observations touch the exact same file and would otherwise coalesce.
   */
  "source-attribution-batch": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* wakatime.record([
            { entity: "/repo/shared.ts", projectFolder: "/repo", source: "session", time: 1_700_000_000_000 },
            // `core` is the same bounded OpenFork attribution as `session`, so it
            // must coalesce rather than manufacture a fourth source bucket.
            { entity: "/repo/shared.ts", projectFolder: "/repo", source: "core", time: 1_700_000_000_500 },
            { entity: "/repo/shared.ts", projectFolder: "/repo", source: "oxp", time: 1_700_000_001_000 },
            { entity: "/repo/oxp-extra.ts", projectFolder: "/repo", source: "oxp", time: 1_700_000_002_000 },
            {
              entity: "/repo/shared.ts",
              projectFolder: "/repo",
              source: "ofxp",
              sourceRef: "secret-principal-ref-must-never-reach-wakatime",
              time: 1_700_000_003_000,
            },
          ])
          yield* wakatime.flush()

          equal(invocations.length, 3, "one project must still spawn once per attribution bucket")
          const nativePlugin = WakaTime.pluginIdentifier()
          const oxpPlugin = WakaTime.pluginIdentifier("openfork-oxp")
          const ofxpPlugin = WakaTime.pluginIdentifier("openfork-ofxp")
          const native = invocations.find((entry) => argValue(entry.args, "--plugin") === nativePlugin)
          const oxp = invocations.find((entry) => argValue(entry.args, "--plugin") === oxpPlugin)
          const ofxp = invocations.find((entry) => argValue(entry.args, "--plugin") === ofxpPlugin)
          assert(native !== undefined, "native OpenFork work must have its own WakaTime attribution")
          assert(oxp !== undefined, "OXP work must have its own WakaTime attribution")
          assert(ofxp !== undefined, "OFXP work must have its own WakaTime attribution")

          equal(argValue(native.args, "--entity"), "/repo/shared.ts", "native attribution must retain its observation")
          equal(argValue(oxp.args, "--entity"), "/repo/shared.ts", "OXP attribution must retain the same-file observation")
          equal(argValue(ofxp.args, "--entity"), "/repo/shared.ts", "OFXP attribution must retain the same-file observation")
          const oxpExtras = JSON.parse(oxp.stdin!.trim()) as Array<{
            entity: string
            entity_type: string
            category: string
            time: number
          }>
          equal(
            oxpExtras,
            [{ entity: "/repo/oxp-extra.ts", entity_type: "file", category: "ai coding", time: 1_700_000_002 }],
            "OXP extras must batch only with OXP and keep the same wire semantics",
          )
          assert(native.stdin === undefined, "native activity must not absorb OXP/OFXP extras")
          assert(ofxp.stdin === undefined, "OFXP activity must not absorb OXP/native extras")
          assert(
            !invocations.some(
              (entry) =>
                entry.args.some((value) => value.includes("secret-principal-ref-must-never-reach-wakatime")) ||
                entry.stdin?.includes("secret-principal-ref-must-never-reach-wakatime"),
            ),
            "raw producer references must never leak into WakaTime attribution or payloads",
          )
          return { spawns: invocations.length, plugins: invocations.map((entry) => argValue(entry.args, "--plugin")) }
        }),
      ),
    )
  },

  /**
   * Attribution changes delivery grouping, never the project's ordinary rate
   * budget. A normal debounce may emit several source groups for one project,
   * but all of them open one shared 60-second project window.
   */
  "source-attribution-limiter": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()

          yield* wakatime.record([
            { entity: "/repo/native.ts", projectFolder: "/repo", source: "session", time: 1_700_000_000_000 },
            { entity: "/repo/oxp.ts", projectFolder: "/repo", source: "oxp", time: 1_700_000_001_000 },
          ])
          assert(yield* waitFor(() => invocations.length === 2, 8_000), "the first project window must deliver both attribution groups")

          const firstPlugins = new Set(invocations.map((entry) => argValue(entry.args, "--plugin")))
          assert(firstPlugins.has(WakaTime.pluginIdentifier()), "the first window must include native OpenFork attribution")
          assert(
            firstPlugins.has(WakaTime.pluginIdentifier("openfork-oxp")),
            "the first window must include OXP attribution",
          )

          // A new attribution bucket does not get a fresh rate budget. Native,
          // OXP, and OFXP work are all held by the same project's open window.
          yield* wakatime.record([
            { entity: "/repo/native-2.ts", projectFolder: "/repo", source: "session", time: 1_700_000_002_000 },
            { entity: "/repo/oxp-2.ts", projectFolder: "/repo", source: "oxp", time: 1_700_000_003_000 },
            { entity: "/repo/ofxp.ts", projectFolder: "/repo", source: "ofxp", time: 1_700_000_004_000 },
          ])
          yield* Effect.sleep(3_000)
          equal(invocations.length, 2, "source attribution must not create independent project delivery windows")

          // Held means delayed, never dropped. A deliberate forced flush emits
          // all three attribution buckets that remained queued.
          yield* wakatime.flush()
          equal(invocations.length, 5, "forced flush must recover all held attribution groups")
          const recovered = [...new Set(invocations.slice(2).map((entry) => argValue(entry.args, "--plugin")))].sort()
          equal(
            recovered,
            [
              WakaTime.pluginIdentifier(),
              WakaTime.pluginIdentifier("openfork-oxp"),
              WakaTime.pluginIdentifier("openfork-ofxp"),
            ].sort(),
            "held work must retain all three attribution identities",
          )
          return { initialSpawns: 2, totalSpawns: invocations.length }
        }),
      ),
    )
  },

  /**
   * Managed-CLI freshness, end to end over a replaced HTTP boundary: a first
   * install, no re-check inside the window, a real refresh when the installed
   * version is unknown, and a replacement when upstream moves on — all while the
   * binary is already resolved for this process.
   */
  "managed-cli-freshness": async () => {
    const home = await managedHome()
    if (!home) return { skipped: true }
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        // Off zero, so a recorded `checkedAt` is distinguishable from the
        // "never checked" sentinel.
        yield* TestClock.adjust("1 second")

        // Nothing is checked before a delivery actually needs a binary.
        equal(versionFetches, 0, "no freshness check may run before delivery needs a binary")
        const status = yield* wakatime.status()
        equal(versionFetches, 0, "a status read must stay network-free")
        equal(archiveFetches, 0, "a status read must not download anything")
        equal(status.source, undefined, "an unresolvable CLI must degrade to no source, never to a download")

        // First delivery: nothing installed and nothing recorded, so the check is
        // due and the latest release is installed and recorded.
        yield* wakatime.record({ entity: "/repo/one.ts", time: 1_700_000_000_000 })
        yield* wakatime.flush()
        equal(versionFetches, 1, "the first delivery must perform exactly one freshness check")
        equal(archiveFetches, 1, "an unknown managed version must actually be installed, not merely recorded")
        equal(yield* readText(home.binary), RELEASE_BYTES, "the verified release bytes must become the managed binary")
        const recorded = JSON.parse(yield* readText(home.state)) as { checkedAt: number; version?: string }
        equal(recorded.version, "1.4.0", "the observed version must be persisted")
        equal(recorded.checkedAt > 0, true, "the attempt must be recorded so the window is bounded")
        equal(invocations[0]!.binary, home.binary, "the installed managed binary must be the one that runs")
        // The initial install goes through the same pinned path.
        pinnedTo("v1.4.0")

        // Inside the window the fast path must be pure in-memory work: no state
        // read, no network, no install.
        yield* TestClock.adjust("1 hour")
        yield* wakatime.record({ entity: "/repo/two.ts", time: 1_700_000_001_000 })
        yield* wakatime.flush()
        equal(versionFetches, 1, "a delivery inside the freshness window must not re-check")
        equal(archiveFetches, 1, "a delivery inside the window must not download anything")
        equal(assetUrls.length, 0, "a delivery inside the window must not request an asset")
        equal(invocations.length, 2, "delivery must still work through the managed binary")
        equal(invocations[1]!.binary, home.binary, "the installed managed binary must be the one that runs")

        // An installed binary whose recorded version is unknown is not provably
        // fresh, so a due check must refresh it rather than only record a version
        // and leave a possibly stale binary in place.
        yield* writeState(home.state, {})
        yield* TestClock.adjust("4 hours")
        yield* wakatime.record({ entity: "/repo/three.ts", time: 1_700_000_002_000 })
        yield* wakatime.flush()
        equal(versionFetches, 2, "a spent window must allow exactly one further check")
        equal(archiveFetches, 2, "an unknown installed version must trigger a real install")
        equal(JSON.parse(yield* readText(home.state)).version, "1.4.0", "the refreshed version must be re-persisted")
        pinnedTo("v1.4.0")

        // A new upstream release replaces the managed binary even though it was
        // already resolved for this process: a cached managed binary must stay
        // eligible for its bounded check instead of being memoized away.
        //
        // The fake "latest" pointer advances the instant this metadata is read,
        // modelling a release published between the metadata fetch and the asset
        // fetches. Both asset URLs, and the version persisted afterwards, must
        // still be the release that was actually observed.
        servedVersion = "1.5.0"
        advanceOnMetadata = true
        yield* TestClock.adjust("4 hours")
        yield* wakatime.record({ entity: "/repo/four.ts", time: 1_700_000_003_000 })
        yield* wakatime.flush()
        equal(versionFetches, 3, "a cached managed binary must stay eligible for its bounded check")
        equal(archiveFetches, 3, "a new upstream version must replace the managed binary")
        pinnedTo("v1.5.0")
        equal(
          JSON.parse(yield* readText(home.state)).version,
          "1.5.0",
          "the persisted version must be the observed release, not the one published mid-flight",
        )
        equal(invocations.length, 4, "every delivery must still reach the managed binary")

        yield* Scope.close(scope, Exit.void)
        return { versionFetches, archiveFetches }
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },

  /**
   * A failed update must be invisible to the caller: the previously installed
   * binary stays exactly as usable, the delivery still happens, and the recorded
   * version is left alone so a later check retries.
   */
  "managed-cli-update-failure": async () => {
    const home = await managedHome()
    if (!home) return { skipped: true }
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        // Off zero, so a recorded `checkedAt` is distinguishable from the
        // "never checked" sentinel.
        yield* TestClock.adjust("1 second")

        yield* wakatime.record({ entity: "/repo/good.ts", time: 1_700_000_000_000 })
        yield* wakatime.flush()
        equal(archiveFetches, 1, "the first delivery must install the verified release")
        equal(yield* readText(home.binary), RELEASE_BYTES, "the managed binary must hold the verified release")

        // Upstream now serves a version we cannot verify.
        servedVersion = "1.6.0"
        const asset = home.asset
        servedArchiveChecksum = `${"0".repeat(64)}  ${asset.archive}\n`
        yield* TestClock.adjust("4 hours")

        yield* wakatime.record({ entity: "/repo/bad.ts", time: 1_700_000_001_000 })
        yield* wakatime.flush()

        equal(versionFetches, 2, "the due check must have run and observed the new version")
        equal(archiveFetches, 2, "the update must have attempted a download")
        // The failing update changed nothing and broke nothing.
        equal(yield* readText(home.binary), RELEASE_BYTES, "a failed update must leave the old managed binary in place")
        equal(invocations.length, 2, "a failed update must not fail the telemetry that triggered it")
        equal(invocations[1]!.binary, home.binary, "delivery must continue through the surviving managed binary")
        equal(
          JSON.parse(yield* readText(home.state)).version,
          "1.4.0",
          "a failed update must not record the unverified version",
        )

        yield* Scope.close(scope, Exit.void)
        return { archiveFetches }
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },

  /**
   * Explicit enablement is a user-driven preparation boundary. A failed
   * initial managed install must leave the opt-in disabled, while an immediate
   * retry must be allowed even though the failed background-style attempt
   * consumed the normal four-hour managed freshness window.
   */
  "enable-prepares-managed-cli": async () => {
    const home = await managedHome(true)
    if (!home) return { skipped: true }
    optInPersisted()
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        const settings = WakaTime.settingsFile()
        yield* TestClock.adjust("1 second")

        const before = yield* wakatime.status()
        equal(before, { enabled: false, configured: true }, "passive status must remain install-free before opt-in")
        equal(versionFetches, 0, "status must not fetch release metadata")
        equal(archiveFetches, 0, "status must not fetch a managed archive")

        const failed = yield* wakatime.setEnabled(true).pipe(Effect.exit)
        assert(Exit.isFailure(failed), "a corrupt initial managed install must fail explicit enablement")
        equal(versionFetches, 1, "the first explicit enable must attempt one managed release lookup")
        equal(archiveFetches, 1, "the first explicit enable must attempt one managed archive download")
        equal(
          yield* Effect.promise(() => Bun.file(settings).exists()),
          false,
          "failed CLI preparation must not persist the opt-in",
        )
        assert(!(yield* wakatime.status()).enabled, "failed preparation must leave the exporter disabled")
        const spent = JSON.parse(yield* readText(home.state)) as { checkedAt?: number }
        assert(
          typeof spent.checkedAt === "number" && spent.checkedAt > 0,
          "a failed managed install must consume and persist the ordinary background backoff window",
        )

        // Temporarily opt in through the higher-precedence env toggle and drive
        // the ordinary delivery path. The failed install above already consumed
        // the four-hour window, so background resolution must honor it and make
        // no second HTTP attempt.
        process.env.OPENFORK_WAKATIME = "1"
        const unavailableActivity = {
          entity: "/repo/background-backoff.ts",
          projectFolder: "/repo",
          source: "session" as const,
          replayToken: "call_unavailable_cli",
          kind: "read" as const,
        }
        yield* wakatime.record({ ...unavailableActivity, time: 1_700_000_000_000 })
        yield* wakatime.flush()
        equal(versionFetches, 1, "background delivery must honor the failed-install freshness backoff")
        equal(archiveFetches, 1, "background delivery must not redownload inside the freshness backoff")
        equal(invocations, [], "a batch with no usable CLI must not be treated as a CLI attempt")
        const deliveryState = Bun.file(WakaTime.deliveryStateFile())
        if (yield* Effect.promise(() => deliveryState.exists())) {
          assert(
            !(yield* Effect.promise(() => deliveryState.text())).includes(WakaTime.deliveryWindowKey("/repo")),
            "an unresolved CLI must not spend the project's delivery window",
          )
        }
        delete process.env.OPENFORK_WAKATIME

        const archive = storedZip(home.asset.binary, new TextEncoder().encode(RELEASE_BYTES))
        servedArchiveChecksum = `${createHash("sha256").update(archive).digest("hex")}  ${home.asset.archive}\n`

        // No clock advance: this retry is deliberately inside the four-hour
        // automatic backoff window consumed by the failed attempt above.
        const enabled = yield* wakatime.setEnabled(true)
        equal(versionFetches, 2, "an explicit retry must bypass the background freshness backoff")
        equal(archiveFetches, 2, "an explicit retry must retry the managed archive immediately")
        equal(enabled.enabled, true, "successful preparation must enable the exporter")
        equal(enabled.configured, true, "the configured credential must remain visible")
        equal(enabled.source, "managed", "successful preparation must report the managed CLI source")
        equal(enabled.cli, home.binary, "successful preparation must return the resolved managed CLI path")
        equal(yield* readText(home.binary), RELEASE_BYTES, "the verified managed CLI must be installed before success")
        equal(
          JSON.parse(yield* Effect.promise(() => Bun.file(settings).text())),
          { enabled: true },
          "the opt-in may be persisted only after CLI preparation succeeds",
        )

        // The failed delivery released its replay token. Replaying the exact
        // observation after preparation must reach the newly installed CLI.
        yield* wakatime.record({ ...unavailableActivity, time: 1_700_000_001_000 })
        yield* wakatime.flush()
        equal(invocations.length, 1, "the previously unattempted observation must become replayable after preparation")
        equal(invocations[0]!.binary, home.binary, "the recovered observation must use the prepared managed CLI")

        yield* Scope.close(scope, Exit.void)
        return { versionFetches, archiveFetches, source: enabled.source }
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },

  "env-disable-skips-cli-prepare": async () => {
    await emptyWakaTimeHome()
    const home = await managedHome()
    if (!home) return { skipped: true }
    process.env.OPENFORK_WAKATIME = "0"
    process.env.WAKATIME_API_KEY = "key"
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        const status = yield* wakatime.setEnabled(true)

        equal(status.enabled, false, "the explicit env disable must remain authoritative")
        equal(status.configured, true, "the credential can remain configured while export is disabled")
        equal(versionFetches, 0, "env-disabled enablement must not fetch managed release metadata")
        equal(archiveFetches, 0, "env-disabled enablement must not download a managed archive")
        equal(
          yield* Effect.promise(() => Bun.file(home.binary).exists()),
          false,
          "env-disabled enablement must not install a managed CLI",
        )
        equal(
          yield* Effect.promise(() => Bun.file(home.state).exists()),
          false,
          "env-disabled enablement must not create managed CLI freshness state",
        )
        equal(
          yield* Effect.promise(() => Bun.file(WakaTime.settingsFile()).exists()),
          false,
          "a forced-off Enable request must not create a latent future opt-in",
        )

        yield* Scope.close(scope, Exit.void)
        return { enabled: status.enabled, versionFetches, archiveFetches }
      }),
    )
  },

  "enable-reuses-override-cli": async () => {
    await emptyWakaTimeHome()
    const binary = await cliFixture()
    optInPersisted()
    versionFetches = 0
    archiveFetches = 0
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        const enabled = yield* wakatime.setEnabled(true)

        equal(enabled.source, "override", "explicit enable must reuse an existing operator override")
        equal(enabled.cli, binary, "explicit enable must return the reused override path")
        equal(versionFetches, 0, "reusing an override must not fetch managed release metadata")
        equal(archiveFetches, 0, "reusing an override must not download a managed archive")
        equal(
          JSON.parse(yield* Effect.promise(() => Bun.file(WakaTime.settingsFile()).text())),
          { enabled: true },
          "reusing an override must still persist the opt-in",
        )

        yield* Scope.close(scope, Exit.void)
        return { source: enabled.source, versionFetches, archiveFetches }
      }),
    )
  },

  "enable-reuses-system-cli": async () => {
    await emptyWakaTimeHome()
    delete process.env.OPENFORK_WAKATIME_CLI
    const dir = await mkdtemp(path.join(os.tmpdir(), "openfork-wakatime-system-"))
    const binary = path.join(dir, process.platform === "win32" ? "wakatime-cli.exe" : "wakatime-cli")
    await writeFile(binary, "system-wakatime-cli")
    const managed = path.join(Global.Path.bin, process.platform === "win32" ? "wakatime-cli.exe" : "wakatime-cli")
    await mkdir(path.dirname(managed), { recursive: true })
    await writeFile(managed, "existing-managed-wakatime-cli")
    process.env.PATH = dir
    optInPersisted()
    versionFetches = 0
    archiveFetches = 0
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        const enabled = yield* wakatime.setEnabled(true)

        equal(enabled.source, "system", "explicit enable must reuse an existing system WakaTime CLI")
        equal(enabled.cli, binary, "explicit enable must return the reused system CLI path")
        equal(versionFetches, 0, "reusing a system CLI must not fetch managed release metadata")
        equal(archiveFetches, 0, "reusing a system CLI must not download a managed archive")
        equal(yield* readText(managed), "existing-managed-wakatime-cli", "a real system CLI must outrank managed")
        equal(
          JSON.parse(yield* Effect.promise(() => Bun.file(WakaTime.settingsFile()).text())),
          { enabled: true },
          "reusing a system CLI must still persist the opt-in",
        )

        yield* Scope.close(scope, Exit.void)
        return { source: enabled.source, versionFetches, archiveFetches }
      }),
    )
  },

  "enable-reuses-managed-cli": async () => {
    await emptyWakaTimeHome()
    const home = await managedHome()
    if (!home) return { skipped: true }
    await mkdir(path.dirname(home.binary), { recursive: true })
    await writeFile(home.binary, VALID_MANAGED_FIXTURE)
    optInPersisted()
    return Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        const enabled = yield* wakatime.setEnabled(true)

        equal(enabled.source, "managed", "explicit enable must reuse an already-installed managed CLI")
        equal(enabled.cli, home.binary, "explicit enable must return the existing managed CLI path")
        equal(versionFetches, 0, "reusing a managed CLI must not perform a freshness lookup")
        equal(archiveFetches, 0, "reusing a managed CLI must not download a replacement")
        equal(
          (yield* Effect.promise(() => readFile(home.binary))).byteLength,
          VALID_MANAGED_FIXTURE.byteLength,
          "explicit enable must not replace an already-usable managed CLI",
        )
        equal(
          yield* Effect.promise(() => Bun.file(home.state).exists()),
          false,
          "reusing a managed CLI must not consume a freshness window",
        )
        equal(
          JSON.parse(yield* Effect.promise(() => Bun.file(WakaTime.settingsFile()).text())),
          { enabled: true },
          "reusing a managed CLI must still persist the opt-in",
        )

        yield* Scope.close(scope, Exit.void)
        return { source: enabled.source, versionFetches, archiveFetches }
      }),
    )
  },

  /**
   * The host Idle/End call. It must be O(1) process-memory work that returns
   * before any CLI work can complete, must not create a per-session fiber or
   * timer, and an urgent session must bypass the project limiter while every
   * other session stays held.
   */
  "request-flush-session": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          // Open the project window with a forced delivery.
          yield* wakatime.record({ entity: "/repo/warm.ts", time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the warming delivery must land")

          // Two sessions queue against the same project, which is now inside its
          // 60s delivery window.
          yield* wakatime.record({ entity: "/repo/urgent.ts", aiSession: "ses_urgent", time: 1_700_000_001_000 })
          yield* wakatime.record({ entity: "/repo/calm.ts", aiSession: "ses_calm", time: 1_700_000_002_000 })

          // A non-blocking request returns on its own, and returns before the
          // debounce window would ever have fired.
          yield* wakatime.requestFlushSession("  ses_urgent  ").pipe(Effect.timeout("3 seconds"))
          assert(
            yield* waitFor(() => invocations.length > 1, 8_000),
            "an urgent session request must be delivered promptly by the one scheduler",
          )
          equal(invocations.length, 2, "only the urgent session may spawn past the limiter")
          equal(
            argValue(invocations[1]!.args, "--entity"),
            "/repo/urgent.ts",
            "the urgent session's work must be the one delivered",
          )

          // The non-urgent session was neither delivered nor dropped.
          yield* wakatime.flush()
          equal(invocations.length, 3, "the non-urgent session must still be queued after an urgent delivery")
          equal(argValue(invocations[2]!.args, "--entity"), "/repo/calm.ts", "the held session's work must survive")

          // A blank selector is a no-op request: no marker, no arm, no delivery.
          invocations = []
          yield* wakatime.record({ entity: "/repo/blank.ts", aiSession: "ses_blank", time: 1_700_000_003_000 })
          yield* wakatime.requestFlushSession("   ")
          yield* Effect.sleep(2_500)
          equal(invocations, [], "a blank request must not accelerate anything")
          yield* wakatime.flush()
          equal(invocations.length, 1, "a blank request must not discard the queued work")
          return { delivered: invocations.length }
        }),
      ),
    )
  },

  /**
   * A request for a session with nothing queued is a true O(1) no-op, and a
   * request for a session that does have queued work still bypasses the limiter
   * and the debounce.
   *
   * The second half is the interesting one: `requestFlushSession` re-arms the
   * ONE shared scheduler, and that run takes every eligible record — not just
   * the requesting session's. So a request for a session with no queued work
   * used to fire the window immediately and pull an unrelated session's work
   * out of the debounce and delivery windows it was deliberately left in. The
   * pending-session index answers that case in one map lookup, before any
   * mutation and before the re-arm.
   */
  "request-flush-unrelated-session": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()

          // An empty queue and a burst of requests: nothing is queued, so there
          // is nothing to accelerate and nothing may be spawned or rescheduled.
          for (let index = 0; index < 64; index++) {
            yield* wakatime.requestFlushSession(`ses_absent_${index}`).pipe(Effect.timeout("3 seconds"))
          }
          equal(yield* waitForDelivery(2_000), false, "requests against an empty queue must not schedule any delivery")
          equal(invocations, [], "a request with no queued work must never spawn the CLI")

          // Session A queues. A's 1.5s coalescing window is the only thing that
          // may deliver it.
          const queuedAt = Date.now()
          yield* wakatime.record({ entity: "/repo/queued.ts", aiSession: "ses_queued", time: 1_700_000_000_000 })

          // A burst of requests, none of which name A. Each must return
          // promptly (the host Idle adapter is on a live event path) and none may
          // advance A's window.
          for (let index = 0; index < 64; index++) {
            yield* wakatime.requestFlushSession(`ses_absent_${index}`).pipe(Effect.timeout("3 seconds"))
          }
          assert(yield* waitForDelivery(8_000), "an unrelated session's request must not strand the queued work")
          equal(invocations.length, 1, "the only queued work must be delivered exactly once")
          equal(
            argValue(invocations[0]!.args, "--entity"),
            "/repo/queued.ts",
            "the queued session's observation must be the delivered one",
          )
          // Measured, not assumed: an accelerated run lands in milliseconds
          // while the debounce needs its full window.
          assert(
            invocations[0]!.at - queuedAt >= 1_400,
            "an unrelated session's request must not accelerate another session's debounce",
          )

          // A request for A itself still bypasses both the debounce and the
          // project limiter, so the index is an accelerator filter and never a
          // new gate on delivery.
          yield* wakatime.record({ entity: "/repo/held.ts", aiSession: "ses_held", time: 1_700_000_001_000 })
          for (let index = 0; index < 64; index++) {
            yield* wakatime.requestFlushSession(`ses_absent_${index}`).pipe(Effect.timeout("3 seconds"))
          }
          const requestedAt = Date.now()
          yield* wakatime.requestFlushSession("ses_held")
          assert(
            yield* waitFor(() => invocations.length > 1, 8_000),
            "a request for a session with queued work must still be delivered promptly",
          )
          equal(invocations.length, 2, "a request must still bypass the project delivery limiter")
          equal(
            argValue(invocations[1]!.args, "--entity"),
            "/repo/held.ts",
            "the requesting session's observation must be the delivered one",
          )
          assert(
            invocations[1]!.at - requestedAt < 1_000,
            "a request for a session with queued work must still skip the debounce",
          )
          return { delivered: invocations.length }
        }),
      ),
    )
  },

  /**
   * A full drain consumes the urgency markers with the queue.
   *
   * `flush()`, runtime teardown, and the opt-out clear all go through `takeAll`,
   * and every marker left behind names a session whose work has just left the
   * queue. Because an already-urgent session is treated as a duplicate, a
   * surviving marker would make the NEXT legitimate immediate request for that
   * session return without arming anything — stranding the new work until the
   * ordinary debounce instead of delivering it promptly.
   */
  "flush-clears-urgency-markers": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          // Open the project window, so the records below are HELD and only an
          // urgent session can accelerate past the limiter.
          yield* wakatime.record({ entity: "/repo/warm.ts", time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the warming delivery must land")

          // A pending session asks for prompt delivery, and the forced flush
          // consumes the whole queue before the scheduler ever reads the marker.
          yield* wakatime.record({ entity: "/repo/first.ts", aiSession: "ses_flush", time: 1_700_000_001_000 })
          yield* wakatime.requestFlushSession("ses_flush")
          yield* wakatime.flush()
          equal(invocations.length, 2, "the flush must deliver the work the request named")
          equal(
            argValue(invocations[1]!.args, "--entity"),
            "/repo/first.ts",
            "the flushed session's observation must be the delivered one",
          )

          // New work for the SAME session, which is inside the delivery window
          // again, so only a fresh urgency marker can accelerate it.
          yield* wakatime.record({ entity: "/repo/second.ts", aiSession: "ses_flush", time: 1_700_000_002_000 })
          const requestedAt = Date.now()
          yield* wakatime.requestFlushSession("ses_flush")
          assert(
            yield* waitFor(() => invocations.length > 2, 5_000),
            "a request after a full flush must still be able to arm the scheduler",
          )
          equal(
            argValue(invocations[2]!.args, "--entity"),
            "/repo/second.ts",
            "the second round's work must be the delivered one",
          )
          assert(
            invocations[2]!.at - requestedAt < 1_000,
            "a stale urgency marker must not suppress the new request's re-arm",
          )
          return { rounds: 2 }
        }),
      ),
    )
  },

  /**
   * `flushSession` drains the same session named by an urgency marker, so it
   * must consume that marker just like a full flush. Otherwise the next request
   * for the session is mistaken for a duplicate and waits behind the ordinary
   * debounce/project limiter.
   */
  "flush-session-clears-urgency-marker": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* wakatime.record({ entity: "/repo/warm.ts", projectFolder: "/repo", time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the warming delivery must open the project window")

          yield* wakatime.record({
            entity: "/repo/first.ts",
            projectFolder: "/repo",
            aiSession: "ses_session_flush",
            time: 1_700_000_001_000,
          })
          yield* wakatime.requestFlushSession("ses_session_flush")
          // Race the armed scheduler deliberately: the explicit completion path
          // drains this session before the urgency marker can be consumed there.
          yield* wakatime.flushSession("ses_session_flush")
          equal(invocations.length, 2, "flushSession must deliver the first round exactly once")

          yield* wakatime.record({
            entity: "/repo/second.ts",
            projectFolder: "/repo",
            aiSession: "ses_session_flush",
            time: 1_700_000_002_000,
          })
          const requestedAt = Date.now()
          yield* wakatime.requestFlushSession("ses_session_flush")
          assert(
            yield* waitFor(() => invocations.length > 2, 5_000),
            "a request after flushSession must install a fresh urgency marker",
          )
          equal(argValue(invocations[2]!.args, "--entity"), "/repo/second.ts", "the second round must be delivered")
          assert(
            invocations[2]!.at - requestedAt < 1_000,
            "a stale marker must not force the second request through the normal debounce",
          )
          return { rounds: 2 }
        }),
      ),
    )
  },

  /**
   * A duplicate Idle for a session that still owns queued work is free, and so is
   * one for a session whose work is already gone.
   *
   * The first request for a pending session arms the one scheduler immediately.
   * Every repeat is already urgent, so it must not replace or re-arm that
   * scheduler, and it must never add a second delivery: the work is delivered
   * exactly once however many duplicate lifecycle events arrive.
   */
  "request-flush-duplicate-session": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          // Open the project window, so the queued work below is HELD and only an
          // urgent session can accelerate past the limiter.
          yield* wakatime.record({ entity: "/repo/warm.ts", time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the warming delivery must land")

          // The first request for a session that DOES own queued work causes one
          // immediate delivery, skipping the debounce entirely.
          yield* wakatime.record({ entity: "/repo/first.ts", aiSession: "ses_dup", time: 1_700_000_001_000 })
          const requestedAt = Date.now()
          yield* wakatime.requestFlushSession("ses_dup")
          assert(
            yield* waitFor(() => invocations.length > 1, 5_000),
            "the first request for a pending session must cause one immediate delivery",
          )
          assert(
            invocations[1]!.at - requestedAt < 1_000,
            "the first request must skip the debounce rather than wait it out",
          )
          equal(
            argValue(invocations[1]!.args, "--entity"),
            "/repo/first.ts",
            "the requesting session's held work must be the delivered one",
          )
          equal(invocations.length, 2, "one request must cost exactly one CLI spawn")

          // Repeated Idle for the SAME session while its work is still queued.
          // Each repeat is already urgent, so none may replace or re-arm the one
          // scheduler, and none may add a delivery.
          yield* wakatime.record({ entity: "/repo/second.ts", aiSession: "ses_dup", time: 1_700_000_002_000 })
          for (let index = 0; index < 8; index++) {
            yield* wakatime.requestFlushSession("ses_dup").pipe(Effect.timeout("3 seconds"))
          }
          assert(
            yield* waitFor(() => invocations.length > 2, 8_000),
            "duplicate requests must not strand the session's own queued work",
          )
          equal(invocations.length, 3, "eight duplicate requests must still cost exactly one spawn")
          equal(
            argValue(invocations[2]!.args, "--entity"),
            "/repo/second.ts",
            "the duplicate-requested session's work must be delivered exactly once",
          )

          // Now that its work is drained, further duplicates are zero-work: no
          // marker, no re-arm, and nothing resurrected.
          invocations = []
          for (let index = 0; index < 8; index++) {
            yield* wakatime.requestFlushSession("ses_dup").pipe(Effect.timeout("3 seconds"))
          }
          yield* Effect.sleep(2_500)
          equal(invocations, [], "a duplicate request after delivery must not wake anything")
          yield* wakatime.flush()
          equal(invocations, [], "a zero-work duplicate must not resurrect delivered work")
          return { duplicates: 8 }
        }),
      ),
    )
  },

  /**
   * The pending-session index tracks the queue exactly, across every way work
   * enters and leaves it: coalescing, queue-pressure eviction, and delivery.
   *
   * A record carrying no session is delivered normally and occupies no index
   * state at all, because a blank selector fails closed and can never be
   * answered by an index entry. An evicted entry's session is retired with it,
   * so a request for that session cannot wake a scheduler for work that no
   * longer exists.
   */
  "pending-session-index-accounting": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          // A record with no session still delivers, and a blank selector is
          // still a no-op: it names no session, so no index entry can answer it.
          yield* wakatime.record({ entity: "/repo/unowned.ts", time: 1_700_000_000_000 })
          yield* wakatime.requestFlushSession("   ")
          yield* wakatime.flush()
          equal(invocations.length, 1, "an unowned record must still deliver")
          equal(
            argValue(invocations[0]!.args, "--entity"),
            "/repo/unowned.ts",
            "the unowned observation must survive a blank selector",
          )

          // Three observations of ONE entity are one queued key, so the session
          // still owns exactly that one entry — and a request for it still
          // accelerates it.
          invocations = []
          const coalesced = { entity: "/repo/coalesce.ts", aiSession: "ses_coalesce" }
          for (let index = 0; index < 3; index++) {
            yield* wakatime.record({ ...coalesced, time: 1_700_000_001_000 + index })
          }
          yield* wakatime.requestFlushSession("ses_coalesce")
          assert(yield* waitForDelivery(8_000), "a coalesced session must still be accelerated by a request")
          equal(invocations.length, 1, "coalescing must not produce extra work")
          equal(
            argValue(invocations[0]!.args, "--entity"),
            "/repo/coalesce.ts",
            "the coalesced entry must be the delivered one",
          )
          assert(
            !invocations[0]!.args.includes("--extra-heartbeats"),
            "three observations of one entity are one queued entry",
          )

          // One entry more than the queue holds, all in a project whose delivery
          // window is still open, so eviction under pressure retires ses_evicted.
          invocations = []
          yield* wakatime.record({
            entity: "/repo/evicted.ts",
            projectFolder: "/repo-queue",
            aiSession: "ses_evicted",
            time: 1_700_000_004_000,
          })
          for (let index = 0; index < WakaTime.MAX_PENDING; index++) {
            yield* wakatime.record({
              entity: `/repo/kept-${index}.ts`,
              projectFolder: "/repo-queue",
              aiSession: "ses_kept",
              time: 1_700_000_005_000 + index,
            })
          }
          // The evicted session owns nothing, so a burst of requests for it must
          // not advance the shared debounce the surviving session is waiting on.
          for (let index = 0; index < 8; index++) {
            yield* wakatime.requestFlushSession("ses_evicted").pipe(Effect.timeout("3 seconds"))
          }
          equal(
            yield* waitFor(() => invocations.length > 0, 400),
            false,
            "a request for an evicted session must not wake the shared scheduler",
          )

          // The session that still owns the whole queue is accelerated instead.
          yield* wakatime.requestFlushSession("ses_kept")
          assert(
            yield* waitForDelivery(8_000),
            "a session that still owns queued work must still be accelerated",
          )
          equal(invocations.length, 1, "one project, one group: one spawn must carry the whole queue")
          const extras = JSON.parse(invocations[0]!.stdin!.trim()) as Array<{ entity: string }>
          equal(extras.length, WakaTime.MAX_PENDING - 1, "every surviving observation must still be queued")
          assert(
            !extras.some((extra) => extra.entity === "/repo/evicted.ts"),
            "an evicted observation must never be delivered",
          )

          // The index drained with the queue, so a last request is free.
          invocations = []
          for (let index = 0; index < 8; index++) {
            yield* wakatime.requestFlushSession("ses_kept").pipe(Effect.timeout("3 seconds"))
          }
          yield* Effect.sleep(2_500)
          equal(invocations, [], "a request after the queue drained must not wake anything")
          return { pending: WakaTime.MAX_PENDING }
        }),
      ),
    )
  },

  /**
   * One scheduler, one bounded urgency set. A burst of session requests from
   * many sessions must not add a timer or a fiber per session, and the markers
   * must not outlive the run that consumes them.
   */
  "request-many-sessions-one-scheduler": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const sessions = ["ses_a", "ses_b", "ses_c", "ses_d", "ses_e", "ses_f", "ses_g"]
          for (const session of sessions) {
            yield* wakatime.record({
              entity: `/repo/${session}.ts`,
              aiSession: session,
              time: 1_700_000_000_000,
            })
          }

          // Every session asks. Each request re-arms the SAME scheduler rather
          // than adding one, so the whole burst resolves through one run.
          for (const session of sessions) yield* wakatime.requestFlushSession(session)
          assert(
            yield* waitFor(() => invocations.length > 0, 8_000),
            "the accelerated scheduler must fire",
          )
          yield* Effect.sleep(1_000)
          // One project, one group: a single spawn carries every urgent session.
          equal(invocations.length, 1, "N session requests must still cost one CLI spawn")
          const extras = JSON.parse(invocations[0]!.stdin!.trim()) as Array<{ entity: string }>
          equal(extras.length, sessions.length - 1, "every urgent session must ride in the one payload")

          // Teardown converges: nothing is left queued, held, or spawning.
          invocations = []
          yield* wakatime.flush()
          equal(invocations.length, 0, "teardown must leave no queued work behind")
          return { sessions: sessions.length }
        }),
      ),
    )
  },

  /**
   * The queue mutex must never be held across wakatime-cli work. A real spawn
   * can block, and a producer must still be able to enqueue while it does.
   */
  "queue-not-held-during-delivery": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const gate = yield* Deferred.make<void>()
          spawnHold = gate
          try {
            yield* wakatime.record({ entity: "/repo/blocked.ts", time: 1_700_000_000_000 })
            const flushing = yield* wakatime.flush().pipe(Effect.forkChild)
            assert(yield* waitFor(() => invocations.length === 1, 5_000), "the fake CLI must have been reached")

            // The CLI is now held open. Enqueueing must still complete promptly:
            // holding the scarce queue semaphore across the spawn would make
            // this time out instead.
            yield* wakatime
              .record({ entity: "/repo/after.ts", aiSession: "ses_after", time: 1_700_000_001_000 })
              .pipe(Effect.timeout("3 seconds"))

            // A non-blocking session request must also return while the spawn is
            // still held, and must not have needed a delivery of its own.
            yield* wakatime.requestFlushSession("ses_after").pipe(Effect.timeout("3 seconds"))
            equal(invocations.length, 1, "a request must not have spawned anything on its own")

            // A second delivery attempt while the first is still blocked must
            // not produce a concurrent CLI process: the delivery permit is
            // separate from the queue lock precisely so this is possible.
            yield* wakatime
              .record({ entity: "/repo/second.ts", time: 1_700_000_002_000 })
              .pipe(Effect.timeout("3 seconds"))
            equal(invocations.length, 1, "no second CLI process may spawn while the first is blocked")
            yield* Effect.sleep(2_000)
            equal(invocations.length, 1, "a held delivery must stay the only pipeline in flight")

            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(flushing)

            // The urgent session's work was taken from the queue before the block
            // and is delivered as soon as the permit frees: delayed, not dropped.
            assert(
              yield* waitFor(() => invocations.length > 1, 8_000),
              "work taken during the block must be delivered once the permit frees",
            )
            equal(
              argValue(invocations[1]!.args, "--entity"),
              "/repo/after.ts",
              "the urgent session's observation must be delivered, not dropped",
            )

            // Work recorded after that was still queued behind the limiter.
            yield* wakatime.flush()
            equal(invocations.length, 3, "work recorded during a blocked delivery must not be lost")
            equal(
              argValue(invocations[2]!.args, "--entity"),
              "/repo/second.ts",
              "the later observation must survive too",
            )
          } finally {
            spawnHold = undefined
          }
        }),
      ),
    )
  },

  /**
   * Automatic delivery owns at most one project per scheduler turn. This is a
   * runtime proof rather than a source-shape check: while project A's spawn is
   * held open, project B must still be sitting in the live queue. An explicit
   * flush therefore takes B and blocks on the delivery permit. Without the
   * fairness slice, B would already have been detached into A's scheduler batch
   * and the flush would return immediately with nothing to do.
   */
  "automatic-project-fairness": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const gate = yield* Deferred.make<void>()
          spawnHold = gate
          try {
            yield* wakatime.record([
              { entity: "/alpha/a.ts", projectFolder: "/alpha", time: 1_700_000_000_000 },
              { entity: "/beta/b.ts", projectFolder: "/beta", time: 1_700_000_001_000 },
            ])

            assert(
              yield* waitFor(() => invocations.length === 1, 8_000),
              "the first automatic project must reach the fake CLI",
            )
            equal(
              argValue(invocations[0]!.args, "--project-folder"),
              "/alpha",
              "insertion order makes alpha the first automatic project",
            )

            const forced = yield* wakatime.flush().pipe(Effect.forkChild)
            const pendingFlush = yield* Fiber.join(forced).pipe(Effect.timeoutOption("250 millis"))
            equal(
              pendingFlush._tag,
              "None",
              "flush must still be waiting because beta remained queued and is blocked on the delivery permit",
            )
            equal(invocations.length, 1, "beta must not have spawned concurrently with alpha")

            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(forced)
            equal(invocations.length, 2, "the forced settlement must deliver beta after alpha releases the permit")
            equal(
              argValue(invocations[1]!.args, "--project-folder"),
              "/beta",
              "the second project must remain intact across the automatic-yield boundary",
            )
            return { spawns: invocations.length }
          } finally {
            spawnHold = undefined
          }
        }),
      ),
    )
  },

  /**
   * A detached batch owns a replay snapshot, not the live pending-key slot. New
   * work for the exact same activity key may therefore enqueue while the older
   * CLI attempt is blocked, and the old batch must never retire the new entry's
   * replay ownership when it settles.
   */
  "same-key-reenqueue-inflight": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const gate = yield* Deferred.make<void>()
          spawnHold = gate
          try {
            const base = {
              entity: "/repo/same.ts",
              projectFolder: "/repo",
              source: "session" as const,
              kind: "write" as const,
              isWrite: true,
            }
            yield* wakatime.record({ ...base, replayToken: "old-call", aiLineChanges: 1, time: 1_700_000_000_000 })
            const first = yield* wakatime.flush().pipe(Effect.forkChild)
            assert(yield* waitFor(() => invocations.length === 1, 5_000), "the first same-key observation must reach the CLI")

            yield* wakatime.record({ ...base, replayToken: "new-call", aiLineChanges: 2, time: 1_700_000_001_000 })
            const second = yield* wakatime.flush().pipe(Effect.forkChild)
            const blocked = yield* Fiber.join(second).pipe(Effect.timeoutOption("250 millis"))
            equal(blocked._tag, "None", "the second same-key batch must wait behind the first delivery permit")
            equal(invocations.length, 1, "same-key re-enqueue must never create a concurrent CLI process")

            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(first)
            yield* Fiber.join(second)
            equal(invocations.length, 2, "both distinct same-key observations must survive detached delivery")
            equal(argValue(invocations[1]!.args, "--ai-line-changes"), "2", "the new same-key observation must retain its own delta")

            // The second observation really was attempted, so replaying the same
            // producer token stays suppressed after both detached batches settle.
            yield* wakatime.record({ ...base, replayToken: "new-call", aiLineChanges: 2, time: 1_700_000_002_000 })
            yield* wakatime.flush()
            equal(invocations.length, 2, "the delivered new-call token must remain replay-suppressed")
            return { delivered: invocations.length }
          } finally {
            spawnHold = undefined
          }
        }),
      ),
    )
  },

  /**
   * A flush can be cancelled while waiting behind another delivery. Its queue
   * entries have already been detached, so the outer delivery finalizer must
   * release their replay tokens even though the permit body never started.
   */
  "permit-wait-interruption-releases-replay": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const gate = yield* Deferred.make<void>()
          spawnHold = gate
          try {
            yield* wakatime.record({ entity: "/repo/blocker.ts", projectFolder: "/repo/a", time: 1_700_000_000_000 })
            const blocker = yield* wakatime.flush().pipe(Effect.forkChild)
            assert(yield* waitFor(() => invocations.length === 1, 5_000), "the blocking delivery must acquire the permit")

            const replayable = {
              entity: "/repo/interrupted.ts",
              projectFolder: "/repo/b",
              source: "session" as const,
              replayToken: "interrupted-call",
              kind: "read" as const,
            }
            yield* wakatime.record({ ...replayable, time: 1_700_000_001_000 })
            const timed = yield* wakatime.flush().pipe(Effect.timeoutOption("250 millis"))
            equal(timed._tag, "None", "the second flush must be interrupted while waiting for the permit")
            equal(invocations.length, 1, "an interrupted permit wait must not spawn")

            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(blocker)

            // The timed-out flush never attempted the CLI, so its replay token
            // must have been released by deliver's outer finalizer.
            yield* wakatime.record({ ...replayable, time: 1_700_000_002_000 })
            yield* wakatime.flush()
            equal(invocations.length, 2, "the interrupted observation must be replayable and recoverable")
            equal(argValue(invocations[1]!.args, "--entity"), "/repo/interrupted.ts", "the recovered observation must be the interrupted one")
            return { delivered: invocations.length }
          } finally {
            spawnHold = undefined
          }
        }),
      ),
    )
  },

  /**
   * Once Core crosses the CLI-attempt boundary, both a non-zero CLI exit and a
   * process-spawn failure consume/persist the project's delivery window and keep
   * the observation's replay token suppressed. They differ from a prerequisite
   * failure, which is covered by `unauthenticated-no-delivery` and is explicitly
   * not an attempt.
   */
  "cli-attempt-failure-semantics": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()

          const nonzero = {
            entity: "/repo/nonzero.ts",
            projectFolder: "/repo/nonzero",
            source: "session" as const,
            replayToken: "nonzero-call",
            kind: "write" as const,
          }
          spawnExitCode = 9
          yield* wakatime.record({ ...nonzero, time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "a non-zero CLI result must still be one real attempt")
          let state = yield* Effect.promise(() => Bun.file(WakaTime.deliveryStateFile()).text())
          assert(
            state.includes(WakaTime.deliveryWindowKey("/repo/nonzero")),
            "a non-zero attempt must persist its project delivery window",
          )

          spawnExitCode = 0
          yield* wakatime.record({ ...nonzero, time: 1_700_000_001_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "replaying a non-zero attempted observation must remain suppressed")

          yield* wakatime.record({
            ...nonzero,
            entity: "/repo/nonzero-new.ts",
            replayToken: "nonzero-new-call",
            time: 1_700_000_002_000,
          })
          yield* Effect.sleep(3_000)
          equal(invocations.length, 1, "a non-zero attempt must spend the ordinary project rate window")
          yield* wakatime.flush()
          equal(invocations.length, 2, "forced settlement must recover new work held behind that spent window")

          const spawnFailed = {
            entity: "/repo/spawn-fail.ts",
            projectFolder: "/repo/spawn-fail",
            source: "session" as const,
            replayToken: "spawn-fail-call",
            kind: "read" as const,
          }
          spawnFailure = new AppProcessError({ command: "wakatime-cli", cause: new Error("fixture spawn failure") })
          yield* wakatime.record({ ...spawnFailed, time: 1_700_000_003_000 })
          yield* wakatime.flush()
          equal(invocations.length, 3, "a process spawn failure must still cross the real-attempt boundary exactly once")
          state = yield* Effect.promise(() => Bun.file(WakaTime.deliveryStateFile()).text())
          assert(
            state.includes(WakaTime.deliveryWindowKey("/repo/spawn-fail")),
            "a spawn failure must persist its project delivery window",
          )

          spawnFailure = undefined
          yield* wakatime.record({ ...spawnFailed, time: 1_700_000_004_000 })
          yield* wakatime.flush()
          equal(invocations.length, 3, "replaying a spawn-failed attempted observation must remain suppressed")
          return { attempts: invocations.length }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              spawnExitCode = 0
              spawnFailure = undefined
            }),
          ),
        ),
      ),
    )
  },

  /**
   * Bounded background state. The delivery-window map is keyed by project
   * directory, so a process that visits many checkouts must not accumulate one
   * entry per project. The proof is behavioural: an evicted project is
   * immediately deliverable again, while a retained one is still held.
   */
  "project-window-bound": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          // More distinct projects than the window bound, delivered in chunks so
          // the queue's own MAX_PENDING bound is never what is under test.
          const total = WakaTime.DELIVERY_PROJECT_BOUND * 2
          const chunk = 128
          for (let start = 0; start < total; start += chunk) {
            for (let index = start; index < Math.min(start + chunk, total); index++) {
              yield* wakatime.record({
                entity: `/p${index}/file.ts`,
                projectFolder: `/p${index}`,
                time: 1_700_000_000_000 + index,
              })
            }
            yield* wakatime.flush()
          }
          equal(invocations.length, total, "every project must be delivered exactly once")

          // /p0 holds the oldest window. If the map were unbounded it would still
          // be held by the limiter; because it is capped, it was evicted and is
          // immediately deliverable.
          invocations = []
          yield* wakatime.record({ entity: "/p0/again.ts", projectFolder: "/p0", time: 1_700_000_900_000 })
          yield* Effect.sleep(3_000)
          equal(invocations.length, 1, "an evicted project window must not still be holding work")

          // The most recent project was retained, so its window still holds.
          const recent = `/p${total - 1}`
          yield* wakatime.record({ entity: `${recent}/again.ts`, projectFolder: recent, time: 1_700_000_900_001 })
          yield* Effect.sleep(3_000)
          equal(invocations.length, 1, "a retained project window must keep holding its project")
          return { projects: total }
        }),
      ),
    )
  },

  /**
   * Replay suppression must not outlive the work it suppressed. An observation
   * dropped only to keep the queue bounded was never delivered, so a producer
   * replaying that authoritative reference must still be accepted — while a
   * replay of work that WAS delivered stays suppressed.
   */
  "replay-evicted-recovers": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          // One more authoritative observation than the queue can hold, so the very
          // first one is evicted for queue pressure rather than delivered.
          const total = WakaTime.MAX_PENDING + 1
          for (let index = 0; index < total; index++) {
            yield* wakatime.record({
              entity: `/repo/f${index}.ts`,
              source: "session",
              replayToken: `call_${index}`,
              kind: "read",
              time: 1_700_000_000_000 + index,
            })
          }
          yield* wakatime.flush()
          equal(invocations.length, 1, "the whole queue must coalesce into one delivery")

          // The evicted observation is replayed by its producer. It was never
          // delivered, so the replay is real work and must be accepted.
          invocations = []
          yield* wakatime.record({
            entity: "/repo/f0.ts",
            source: "session",
            replayToken: "call_0",
            kind: "read",
            time: 1_700_000_100_000,
          })
          yield* wakatime.flush()
          equal(invocations.length, 1, "a replay of an evicted observation must be recoverable")
          equal(argValue(invocations[0]!.args, "--entity"), "/repo/f0.ts", "the recovered replay must be delivered")

          // A replay of work that was actually delivered is still suppressed.
          invocations = []
          yield* wakatime.record({
            entity: "/repo/f7.ts",
            source: "session",
            replayToken: "call_7",
            kind: "read",
            time: 1_700_000_200_000,
          })
          yield* wakatime.flush()
          equal(invocations, [], "a replay of a delivered observation must remain suppressed")
          return { total }
        }),
      ),
    )
  },

  /**
   * One pending entry can absorb several distinct authoritative calls before it
   * is ever delivered, and the merged activity only retains the latest reference.
   * When queue pressure evicts that entry, none of it was delivered — so every
   * coalesced reference must be recoverable, not just the newest one.
   */
  "replay-coalesced-recovers": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          // Same file, same session, same project: these two authoritative calls
          // coalesce onto ONE pending entry, and only the second survives the merge.
          const first = {
            entity: "/repo/first.ts",
            aiSession: "ses_coalesce",
            source: "session" as const,
            kind: "read" as const,
          }
          yield* wakatime.record({ ...first, replayToken: "call_a", time: 1_700_000_000_000 })
          yield* wakatime.record({ ...first, replayToken: "call_b", time: 1_700_000_001_000 })

          // Then enough distinct entities to push that entry out under queue pressure.
          for (let index = 0; index < WakaTime.MAX_PENDING; index++) {
            yield* wakatime.record({
              entity: `/repo/x${index}.ts`,
              source: "session",
              replayToken: `x_${index}`,
              kind: "read",
              time: 1_700_000_002_000 + index,
            })
          }
          yield* wakatime.flush()
          equal(invocations.length, 1, "the queue must coalesce into one delivery")

          // Both coalesced references were never delivered, so both recover.
          invocations = []
          yield* wakatime.record({ ...first, replayToken: "call_a", time: 1_700_000_100_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the older coalesced call must be recoverable")
          equal(argValue(invocations[0]!.args, "--entity"), "/repo/first.ts", "the recovered call must be delivered")

          invocations = []
          yield* wakatime.record({ ...first, replayToken: "call_b", time: 1_700_000_101_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the newer coalesced call must be recoverable too")

          // A reference whose entry WAS delivered stays suppressed.
          invocations = []
          yield* wakatime.record({
            entity: "/repo/x7.ts",
            source: "session",
            replayToken: "x_7",
            kind: "read",
            time: 1_700_000_200_000,
          })
          yield* wakatime.flush()
          equal(invocations, [], "a delivered reference must remain suppressed")

          // A delivered coalesced entry keeps suppressing BOTH of its references.
          invocations = []
          yield* wakatime.record({ ...first, replayToken: "call_a", time: 1_700_000_300_000 })
          yield* wakatime.flush()
          equal(invocations, [], "a delivered coalesced entry must keep suppressing its references")
          return { coalesced: ["call_a", "call_b"] }
        }),
      ),
    )
  },

  /**
   * The download is bounded while streaming, not checked after the fact. An
   * over-declared body is rejected before a byte is consumed, an undeclared body
   * is abandoned the moment it crosses the limit, and neither can install
   * anything. A valid small body still works afterwards.
   */
  "managed-http-byte-bounds": async () => {
    const home = await managedHome()
    if (!home) return { skipped: true }
    const exists = () => Effect.promise(() => Bun.file(home.binary).exists())
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()
        const scope = yield* Scope.make()
        const wakatime = yield* buildInto(scope, managedBuild)
        yield* TestClock.adjust("1 second")

        // A declared Content-Length over the limit fails before the stream is read.
        assetBodyMode = "declared-oversize"
        chunksServed = 0
        chunksTotal = 4
        yield* wakatime.record({ entity: "/repo/declared.ts", time: 1_700_000_000_000 })
        yield* wakatime.flush()
        equal(chunksServed, 0, "an over-declared body must be rejected before it is consumed")
        equal(yield* exists(), false, "an over-declared body must never be installed")

        // No Content-Length at all: the collector must stop at the boundary and
        // never buffer the remainder.
        assetBodyMode = "chunked-oversize"
        chunksServed = 0
        chunksTotal = 512
        yield* TestClock.adjust("4 hours")
        yield* wakatime.record({ entity: "/repo/streamed.ts", time: 1_700_000_001_000 })
        yield* wakatime.flush()
        assert(chunksServed > 0, "a streamed body must be consumed up to the limit")
        assert(chunksServed < chunksTotal, "the remainder of an over-limit body must never be buffered")
        equal(yield* exists(), false, "an over-limit body must never be installed")

        // A failed attempt records no version, so a later check retries rather
        // than treating the failure as a completed decision.
        equal(
          JSON.parse(yield* readText(home.state)).version,
          undefined,
          "an unverified body must not be recorded as an installed version",
        )

        // The bound is not a blanket failure: a valid small body still installs.
        assetBodyMode = "bytes"
        chunksServed = 0
        yield* TestClock.adjust("4 hours")
        yield* wakatime.record({ entity: "/repo/good.ts", time: 1_700_000_002_000 })
        yield* wakatime.flush()
        equal(yield* exists(), true, "a valid body must still install after a bounded failure")
        equal(yield* readText(home.binary), RELEASE_BYTES, "the verified release must be the installed binary")
        equal(JSON.parse(yield* readText(home.state)).version, "1.4.0", "the observed version must be recorded")

        yield* Scope.close(scope, Exit.void)
        return { chunksServed }
      }).pipe(Effect.provide(TestClock.layer())),
    )
  },

  /**
   * One scheduler, no matter how many sessions ask while the CLI is blocked.
   *
   * The fake CLI is held open and then a burst of records plus a burst of session
   * requests are issued. Nothing may spawn concurrently, nothing may be dropped,
   * and when the delivery finishes the single scheduler resumes and accounts for
   * the whole burst exactly once.
   */
  "single-scheduler-burst": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const gate = yield* Deferred.make<void>()
          spawnHold = gate
          try {
            yield* wakatime.record({ entity: "/repo/held.ts", time: 1_700_000_000_000 })
            const flushing = yield* wakatime.flush().pipe(Effect.forkChild)
            assert(yield* waitFor(() => invocations.length === 1, 5_000), "the fake CLI must have been reached")

            // A burst of sessions records work, then every one of them asks.
            for (let index = 0; index < 100; index++) {
              yield* wakatime
                .record({
                  entity: `/repo/burst-${index}.ts`,
                  aiSession: `ses_${index}`,
                  time: 1_700_000_001_000 + index,
                })
                .pipe(Effect.timeout("5 seconds"))
            }
            for (let index = 0; index < 100; index++) {
              yield* wakatime.requestFlushSession(`ses_${index}`).pipe(Effect.timeout("5 seconds"))
            }

            yield* Effect.sleep(2_000)
            equal(
              invocations.length,
              1,
              "a burst of sessions must not spawn a second CLI process while one is in flight",
            )

            yield* Deferred.succeed(gate, undefined)
            yield* Fiber.join(flushing)
            assert(
              yield* waitFor(() => invocations.length > 1, 10_000),
              "the single scheduler must resume once the delivery finishes",
            )
            // The urgency set is hard-bounded, so a 100-session burst cannot
            // exempt every session from the limiter in one run however many
            // sessions asked. That is the bound working, not a loss.
            const resumed = invocations[1]!
            const extras = JSON.parse(resumed.stdin!.trim()) as Array<{ entity: string }>
            equal(
              extras.length,
              WakaTime.URGENT_SESSION_BOUND - 1,
              "one run may exempt at most the bounded urgency window",
            )

            // Nothing was dropped: the sessions the bound left out are still
            // queued, and a forced flush accounts for exactly them.
            invocations = []
            yield* wakatime.flush()
            equal(invocations.length, 1, "the remainder of the burst must still be queued")
            const remainder = JSON.parse(invocations[0]!.stdin!.trim()) as Array<{ entity: string }>
            equal(
              remainder.length,
              100 - WakaTime.URGENT_SESSION_BOUND - 1,
              "every held burst observation must be delivered exactly once",
            )

            // And nothing is left behind.
            invocations = []
            yield* wakatime.flush()
            equal(invocations, [], "the burst must be fully drained, not left queued")
          } finally {
            spawnHold = undefined
          }
        }),
      ),
    )
  },

  "managed-cli-stays-offline": async () => {
    await emptyWakaTimeHome()
    const binary = await cliFixture()
    const state = WakaTime.cliStateFile()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          const status = yield* wakatime.status()
          equal(status.source, "override", "an operator override must keep precedence over managed")
          equal(status.cli, binary, "status must report the override binary")
          equal(invocations, [], "status must not spawn anything")
          equal(
            yield* Effect.promise(() => Bun.file(state).exists()),
            false,
            "a status read must not create managed-CLI check state",
          )

          // Delivery still resolves through the override, so the managed path is
          // never consulted and an operator's binary is never replaced.
          yield* wakatime.record({ entity: "/repo/offline.ts", time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "delivery must still work through the override")
          equal(invocations[0]!.binary, binary, "an override binary must never be replaced by an update")
          equal(
            yield* Effect.promise(() => Bun.file(state).exists()),
            false,
            "an override or system install must never trigger a managed freshness check",
          )

          // The persisted check metadata is non-secret by construction: the
          // window and version only, never a credential.
          const due = WakaTime.managedCheckDue(WakaTime.DEFAULT_MANAGED_STATE, Date.now())
          assert(due, "a runtime with no recorded check must be due for one")
          equal(
            WakaTime.managedCheckDue({ checkedAt: Date.now() }, Date.now()),
            false,
            "a recorded check must close the window for the next four hours",
          )
          return { source: status.source }
        }),
      ),
    )
  },

  "unauthenticated-no-delivery": async () => {
    await cliFixture()
    await emptyWakaTimeHome()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          process.env.OPENFORK_WAKATIME = "1"
          const activity = {
            entity: "/repo/a.ts",
            projectFolder: "/repo",
            source: "session" as const,
            replayToken: "call_unconfigured",
            kind: "read" as const,
          }
          yield* wakatime.record(activity)
          yield* wakatime.flush()
          equal(invocations, [], "opted in but unauthenticated must not deliver")

          const stateFile = Bun.file(WakaTime.deliveryStateFile())
          if (yield* Effect.promise(() => stateFile.exists())) {
            const persisted = yield* Effect.promise(() => stateFile.text())
            assert(
              !persisted.includes(WakaTime.deliveryWindowKey("/repo")),
              "a batch that never reached the CLI must not spend the project's delivery window",
            )
          }

          // The dropped attempt must release its replay token as well. Once the
          // credential appears, replaying the exact same logical observation is
          // accepted and the ordinary debounce can deliver it immediately — no
          // stale 60-second limiter window from the unauthenticated flush.
          process.env.WAKATIME_API_KEY = "key"
          yield* wakatime.record({ ...activity, time: 1_700_000_001_000 })
          assert(
            yield* waitForDelivery(8_000),
            "the same observation must become deliverable as soon as credentials appear",
          )
          equal(invocations.length, 1, "the authenticated retry must deliver exactly once")
          equal(argValue(invocations[0]!.args, "--entity"), "/repo/a.ts", "the retried observation must be delivered")
        }),
      ),
    )
  },

  "coding-activity-single-consumer": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          yield* CodingActivity.record({
            entity: "/repo/src/index.ts",
            kind: "write",
            time: 1_700_000_000,
            aiLineChanges: 7,
            source: "session",
          })
          yield* settle
          yield* wakatime.flush()

          equal(invocations.length, 1, "one published activity must yield one heartbeat batch")
          const args = invocations[0]!.args
          equal(argValue(args, "--entity"), "/repo/src/index.ts", "the entity must survive projection")
          equal(argValue(args, "--time"), "1700000000", "seconds must lower to CLI seconds")
          assert(args.includes("--write"), "a write must project to --write")
          // A duplicated subscriber would record the same activity twice and
          // sum the line changes to 14.
          equal(argValue(args, "--ai-line-changes"), "7", "the activity must be consumed exactly once")
          assert(args.includes("--sync-ai-disabled"), "the exporter must own its own activity producer")
        }),
      ),
    )
  },

  /**
   * Core owns the opt-in mutation: the persisted setting defaults to disabled,
   * `setEnabled` flips it and takes effect for delivery, and an explicit env
   * toggle still wins over the persisted value.
   */
  "set-enabled": async () => {
    await emptyWakaTimeHome()
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          process.env.WAKATIME_API_KEY = "key"
          const target = WakaTime.settingsFile()

          equal(
            yield* wakatime.status(),
            { enabled: false, configured: true },
            "an absent persisted setting must read as disabled",
          )
          equal(
            yield* Effect.promise(() => Bun.file(target).exists()),
            false,
            "reading status must not create persisted state",
          )

          // Enabling is a Core mutation, not an env side effect.
          const enabled = yield* wakatime.setEnabled(true)
          assert(enabled.enabled, "setEnabled(true) must report the effective opt-in")
          equal(
            JSON.parse(yield* Effect.promise(() => Bun.file(target).text())),
            { enabled: true },
            "only the enablement flag is persisted",
          )

          yield* wakatime.record({ entity: "/repo/on.ts", time: 1_700_000_000_000 })
          yield* wakatime.flush()
          equal(invocations.length, 1, "an enabled exporter must deliver")

          // Disabling drops already-queued time rather than sending it late.
          invocations = []
          yield* wakatime.record({ entity: "/repo/off.ts", time: 1_700_000_001_000 })
          const disabled = yield* wakatime.setEnabled(false)
          assert(!disabled.enabled, "setEnabled(false) must report the effective opt-in")
          yield* wakatime.record({ entity: "/repo/off2.ts", time: 1_700_000_002_000 })
          yield* wakatime.flush()
          equal(invocations, [], "a disabled exporter must not deliver queued or new activity")

          // An explicit env override outranks the persisted setting.
          process.env.OPENFORK_WAKATIME = "1"
          assert((yield* wakatime.status()).enabled, "an explicit env toggle must override persisted disabled")
          process.env.OPENFORK_WAKATIME = "0"
          assert(!(yield* wakatime.status()).enabled, "an explicit env disable must override persisted enabled")

          return { persisted: JSON.parse(yield* Effect.promise(() => Bun.file(target).text())) }
        }),
      ),
    )
  },

  /**
   * Opting out must take the runtime's transient state with it: the scheduler
   * stops, the queue is dropped, and the bookkeeping that would otherwise
   * suppress or throttle a future re-enable is forgotten.
   */
  "opt-out-clears-transient-state": async () => {
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optInPersisted()
          // The persisted setting is the effective opt-in here, and it defaults
          // to disabled, so it has to be turned on before anything is queued.
          assert((yield* wakatime.setEnabled(true)).enabled, "the persisted opt-in must be reported")
          // An authoritative observation, a project delivery window, an urgency
          // marker, and more work still queued behind the debounce.
          yield* wakatime.record({
            entity: "/repo/q.ts",
            projectFolder: "/repo",
            source: "session",
            replayToken: "call_1",
            kind: "read",
            time: 1_700_000_000_000,
          })
          yield* wakatime.flush()
          equal(invocations.length, 1, "the first delivery must land")
          yield* wakatime.requestFlushSession("ses_optout")
          // A project delivery window and more work still queued behind the
          // debounce. The request names a session with nothing queued, so the
          // pending-session index answers it with no marker and no re-arm: it
          // must not become a way to accelerate the burst below.
          yield* wakatime.record({
            entity: "/repo/dropped.ts",
            projectFolder: "/repo",
            source: "session",
            replayToken: "call_drop",
            kind: "read",
            time: 1_700_000_001_000,
          })
          yield* wakatime.requestFlushSession("ses_optout")

          assert(!(yield* wakatime.setEnabled(false)).enabled, "opt-out must be reported")
          // The scheduler was cancelled, so a queued burst is not sent after the
          // user opted out.
          yield* Effect.sleep(3_000)
          equal(invocations.length, 1, "opting out must cancel the scheduler and drop queued work")

          assert((yield* wakatime.setEnabled(true)).enabled, "re-enabling must be reported")

          // The project delivery window was cleared too: a burst for the same
          // project must not inherit throttling from before the opt-out, and the
          // scheduler must be armed again.
          invocations = []
          yield* wakatime.record({ entity: "/repo/after.ts", projectFolder: "/repo", time: 1_700_000_200_000 })
          assert(
            yield* waitFor(() => invocations.length > 0, 8_000),
            "a re-enabled exporter must not inherit stale delivery throttling",
          )
          equal(
            argValue(invocations[0]!.args, "--entity"),
            "/repo/after.ts",
            "the post-re-enable burst must be the one delivered",
          )

          // Replay suppression was forgotten along with the queue: the dropped
          // observation was never delivered, so it must be replayable. Forced, so
          // the project window opened above cannot confound the check.
          invocations = []
          yield* wakatime.record({
            entity: "/repo/dropped.ts",
            projectFolder: "/replay",
            source: "session",
            replayToken: "call_drop",
            kind: "read",
            time: 1_700_000_300_000,
          })
          yield* wakatime.flush()
          equal(invocations.length, 1, "an observation dropped by opt-out must be replayable after re-enable")
        }),
      ),
    )
  },

  /**
   * An explicit env override outranks the persisted checkbox, so the persisted
   * setting alone must not decide whether queued work survives or is dropped.
   */
  "opt-out-env-precedence": async () => {
    await emptyWakaTimeHome()
    await cliFixture()
    return Effect.runPromise(
      withService((wakatime) =>
        Effect.gen(function* () {
          optIn()
          process.env.OPENFORK_WAKATIME = "1"
          yield* wakatime.record({ entity: "/repo/keep.ts", time: 1_700_000_000_000 })
          assert((yield* wakatime.setEnabled(false)).enabled, "an env opt-in must outrank a persisted opt-out")
          equal(
            JSON.parse(yield* Effect.promise(() => Bun.file(WakaTime.settingsFile()).text())).enabled,
            false,
            "the persisted opt-out must still be written",
          )
          yield* wakatime.flush()
          equal(invocations.length, 1, "queued work must survive a persisted opt-out under an env opt-in")

          invocations = []
          process.env.OPENFORK_WAKATIME = "0"
          assert(!(yield* wakatime.setEnabled(true)).enabled, "an env opt-out must outrank a persisted opt-in")
          yield* wakatime.record({ entity: "/repo/held.ts", time: 1_700_000_001_000 })
          yield* wakatime.flush()
          equal(invocations, [], "an effectively disabled exporter must not deliver")
        }),
      ),
    )
  },

  /**
   * The singleton invariant. Two independent graph builds in one process must
   * resolve to the same service, and therefore to the same single subscriber.
   */
  singleton: async () => {
    await cliFixture()
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()
        const firstScope = yield* Scope.make()
        const secondScope = yield* Scope.make()

        const first = yield* buildInto(firstScope)
        const second = yield* buildInto(secondScope)
        assert(first === second, "a second graph build must reuse the process exporter")

        yield* CodingActivity.record({
          entity: "/repo/singleton.ts",
          kind: "write",
          time: 1_700_000_000,
          aiLineChanges: 11,
          source: "core",
        })
        yield* settle
        yield* first.flush()

        equal(invocations.length, 1, "one publisher must not fan out across graph builds")
        equal(
          argValue(invocations[0]!.args, "--ai-line-changes"),
          "11",
          "a duplicate subscriber would double the line changes",
        )

        yield* Scope.close(firstScope, Exit.void)
        yield* Scope.close(secondScope, Exit.void)
        return { reused: true }
      }),
    )
  },

  /**
   * Two graphs built concurrently in one process must not race into two
   * runtimes. Creation is a critical section, so the second build either waits
   * for the first or reuses the live runtime: one published activity still
   * yields one heartbeat batch, not two.
   */
  "concurrent-singleton": async () => {
    await cliFixture()
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()
        const firstScope = yield* Scope.make()
        const secondScope = yield* Scope.make()

        const [first, second] = yield* Effect.all([buildInto(firstScope), buildInto(secondScope)], {
          concurrency: "unbounded",
        })
        assert(first === second, "concurrent graph builds must share one process exporter")

        yield* CodingActivity.record({
          entity: "/repo/concurrent.ts",
          kind: "write",
          time: 1_700_000_000,
          aiLineChanges: 11,
          source: "core",
        })
        yield* settle
        yield* first.flush()

        equal(invocations.length, 1, "a second process runtime would send the same activity again")
        equal(
          argValue(invocations[0]!.args, "--ai-line-changes"),
          "11",
          "the activity must be consumed by exactly one subscriber",
        )

        yield* Scope.close(firstScope, Exit.void)
        yield* Scope.close(secondScope, Exit.void)
        return { reused: true }
      }),
    )
  },

  /**
   * The graph that first built the runtime is not the graph that owns it. Closing
   * it must leave the shared runtime's own debounce window and an explicit flush
   * working for the graph that still holds a lease.
   */
  "graph-close-reuse": async () => {
    await cliFixture()
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()
        const ownerScope = yield* Scope.make()
        const laterScope = yield* Scope.make()

        const owner = yield* buildInto(ownerScope)
        const later = yield* buildInto(laterScope)
        assert(owner === later, "a second graph must reuse the live process runtime")

        yield* Scope.close(ownerScope, Exit.void)

        // No manual flush: the reused runtime's own debounce window has to fire,
        // which is only possible while the timer outlives the graph that built it.
        yield* later.record({ entity: "/repo/after-close.ts", time: 1_700_000_000_000 })
        assert(yield* waitForDelivery(8_000), "the reused runtime must still deliver through its own debounce window")
        equal(invocations.length, 1, "the reused runtime must deliver exactly once")
        equal(
          argValue(invocations[0]!.args, "--entity"),
          "/repo/after-close.ts",
          "the surviving runtime must deliver what was recorded after the first graph closed",
        )

        invocations = []
        yield* later.record({ entity: "/repo/flush-after-close.ts", time: 1_700_000_001_000 })
        yield* later.flush()
        equal(invocations.length, 1, "an explicit flush must survive the first graph's close")

        // Closing the last graph finalizes the runtime, so the next graph has to
        // build a fresh exporter rather than inherit a finalized one.
        yield* Scope.close(laterScope, Exit.void)
        invocations = []
        const rebuiltScope = yield* Scope.make()
        const rebuilt = yield* buildInto(rebuiltScope)
        assert(rebuilt !== later, "a later graph must build a fresh runtime, not the finalized one")
        yield* rebuilt.record({ entity: "/repo/rebuilt.ts", time: 1_700_000_002_000 })
        yield* rebuilt.flush()
        equal(invocations.length, 1, "a rebuilt runtime must deliver again")
        equal(argValue(invocations[0]!.args, "--entity"), "/repo/rebuilt.ts", "the rebuilt runtime must own the queue")
        yield* Scope.close(rebuiltScope, Exit.void)
      }),
    )
  },

  /**
   * Lifecycle is intentional, not an unbounded detached leak: the last graph to
   * release the runtime finalizes it, and a later graph builds a fresh one
   * instead of inheriting a dead subscriber.
   */
  "last-lease-finalizes": async () => {
    await cliFixture()
    return Effect.runPromise(
      Effect.gen(function* () {
        optIn()
        const firstScope = yield* Scope.make()
        const first = yield* buildInto(firstScope)
        yield* Scope.close(firstScope, Exit.void)

        // A finalized exporter is gone from the process bus: activity published
        // after the last graph closed must be neither consumed nor delivered.
        yield* CodingActivity.record({
          entity: "/repo/after-finalize.ts",
          kind: "write",
          time: 1_700_000_000,
          source: "core",
        })
        yield* settle
        equal(yield* waitForDelivery(2_500), false, "a finalized exporter must not keep consuming the process bus")
        equal(invocations, [], "a finalized exporter must not deliver anything")

        const secondScope = yield* Scope.make()
        const second = yield* buildInto(secondScope)
        assert(second !== first, "a rebuilt runtime must be a fresh exporter, not the finalized one")
        yield* second.record({ entity: "/repo/rebuilt.ts", time: 1_700_000_000_000 })
        yield* second.flush()
        equal(invocations.length, 1, "a rebuilt runtime must deliver again")
        equal(argValue(invocations[0]!.args, "--entity"), "/repo/rebuilt.ts", "the rebuilt runtime must own the queue")
        yield* Scope.close(secondScope, Exit.void)
      }),
    )
  },
}

const name = process.argv[2]
const scenario = name ? scenarios[name] : undefined
if (!scenario) {
  process.stderr.write(
    `unknown scenario: ${name ?? "<none>"}\navailable: ${Object.keys(scenarios).sort().join(" ")}\n`,
  )
  process.exit(2)
}

try {
  const result = await scenario()
  process.stdout.write(`${RESULT_MARKER}${JSON.stringify(result ?? null)}\n`)
  await rm(fixtureCache, { recursive: true, force: true })
  process.exit(0)
} catch (error) {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
  await rm(fixtureCache, { recursive: true, force: true }).catch(() => undefined)
  process.exit(1)
}
