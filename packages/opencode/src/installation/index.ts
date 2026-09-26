import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { httpClient } from "@opencode-ai/core/effect/app-node-platform"
import { PRODUCT_RELEASES_URL, PRODUCT_REPOSITORY_API_URL, PRODUCT_REPOSITORY_URL } from "@opencode-ai/core/brand"
import { Effect, Layer, Schema, Context, Stream } from "effect"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import { makeRuntime } from "@opencode-ai/core/effect/runtime"
import semver from "semver"
import {
  InstallationChannel,
  InstallationUserAgent,
  InstallationVersion,
} from "@opencode-ai/core/installation/version"
import { InstallationEvent } from "@opencode-ai/schema/installation-event"
import { DIRECT_INSTALL_DIRNAME, LEGACY_DIRECT_INSTALL_DIRNAME } from "@opencode-ai/core/storage-identity"

/**
 * Fork-owned installation methods.
 *
 * OpenFork does not claim ownership of upstream npm/Homebrew/Scoop/Chocolatey
 * channels. Anything outside the direct ~/.openfork/bin installation (plus the
 * legacy ~/.opencode/bin path during migration) is treated
 * as externally managed so OpenFork can never replace itself with an upstream
 * OpenCode package during self-update.
 */
export type Method = "curl" | "unknown"

export type ReleaseType = "patch" | "minor" | "major"

export const Event = InstallationEvent

export function getReleaseType(current: string, latest: string): ReleaseType {
  const currMajor = semver.major(current)
  const currMinor = semver.minor(current)
  const newMajor = semver.major(latest)
  const newMinor = semver.minor(latest)

  if (newMajor > currMajor) return "major"
  if (newMinor > currMinor) return "minor"
  return "patch"
}

export const Info = Schema.Struct({
  version: Schema.String,
  latest: Schema.String,
}).annotate({ identifier: "InstallationInfo" })
export type Info = Schema.Schema.Type<typeof Info>

export function userAgent(client = "cli") {
  void client
  return InstallationUserAgent()
}

export const USER_AGENT = userAgent()

export function isPreview() {
  return InstallationChannel !== "latest"
}

export function isLocal() {
  return InstallationChannel === "local"
}

export class UpgradeFailedError extends Schema.TaggedErrorClass<UpgradeFailedError>()("UpgradeFailedError", {
  stderr: Schema.String,
}) {
  override get message() {
    return this.stderr
  }
}

const GitHubRelease = Schema.Struct({
  tag_name: Schema.String,
  draft: Schema.Boolean,
  prerelease: Schema.Boolean,
})
export type GitHubReleaseInfo = Schema.Schema.Type<typeof GitHubRelease>

function normalizedVersion(tag: string) {
  return tag.replace(/^v/, "")
}

function releaseMatchesChannel(release: GitHubReleaseInfo, channel: string) {
  if (release.draft) return false
  const version = normalizedVersion(release.tag_name)
  if (!semver.valid(version)) return false
  if (channel === "latest") return !release.prerelease
  if (!release.prerelease) return false

  const first = semver.prerelease(version)?.[0]
  return typeof first === "string" && (first === channel || first.startsWith(`${channel}-`))
}

export function releaseVersionForChannel(releases: readonly GitHubReleaseInfo[], channel: string) {
  const release = releases.find((item) => releaseMatchesChannel(item, channel))
  return release ? normalizedVersion(release.tag_name) : undefined
}

export function isDirectInstallPath(execPath: string, platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return false
  const normalized = execPath.replaceAll("\\", "/")
  return [DIRECT_INSTALL_DIRNAME, LEGACY_DIRECT_INSTALL_DIRNAME].some((dir) =>
    normalized.endsWith(`/${dir}/bin/opencode`),
  )
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

export function openForkDirectUpgradeScript(input: { version: string; target: string }) {
  const version = normalizedVersion(input.version)
  return [
    "set -eu",
    `version=${shellQuote(version)}`,
    `target=${shellQuote(input.target)}`,
    `repo=${shellQuote(PRODUCT_REPOSITORY_URL)}`,
    'platform="$(uname -s):$(uname -m)"',
    'libc=""',
    'if [ "$(uname -s)" = "Linux" ] && (ldd --version 2>&1 || true) | grep -qi musl; then libc="-musl"; fi',
    'case "$platform" in',
    '  Linux:x86_64|Linux:amd64)',
    '    baseline=""',
    '    grep -qw avx2 /proc/cpuinfo 2>/dev/null || baseline="-baseline"',
    '    asset="opencode-linux-x64${baseline}${libc}.tar.gz"; archive="tar" ;;',
    '  Linux:aarch64|Linux:arm64) asset="opencode-linux-arm64${libc}.tar.gz"; archive="tar" ;;',
    '  Darwin:x86_64|Darwin:amd64)',
    '    baseline=""',
    '    sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qw AVX2 || baseline="-baseline"',
    '    asset="opencode-darwin-x64${baseline}.zip"; archive="zip" ;;',
    '  Darwin:arm64|Darwin:aarch64) asset="opencode-darwin-arm64.zip"; archive="zip" ;;',
    '  *) echo "OpenFork does not publish a CLI binary for $platform" >&2; exit 2 ;;',
    "esac",
    'tmp="$(mktemp -d)"',
    'mkdir -p "$(dirname "$target")"',
    'staged="${target}.openfork-update-$$"',
    'trap \'rm -rf "$tmp"; rm -f "$staged"\' EXIT',
    'url="$repo/releases/download/v$version/$asset"',
    'curl --fail --location --silent --show-error "$url" --output "$tmp/archive"',
    'if [ "$archive" = "tar" ]; then',
    '  tar -xzf "$tmp/archive" -C "$tmp"',
    "else",
    '  unzip -q "$tmp/archive" -d "$tmp"',
    "fi",
    'test -f "$tmp/opencode" || { echo "OpenFork release archive is missing the opencode compatibility executable" >&2; exit 3; }',
    'install -m 0755 "$tmp/opencode" "$staged"',
    'staged_version="$("$staged" --version)"',
    'test "$staged_version" = "$version" || { echo "Downloaded OpenFork binary reported $staged_version; expected $version" >&2; exit 4; }',
    'mv -f "$staged" "$target"',
    'actual="$("$target" --version)"',
    'test "$actual" = "$version" || { echo "OpenFork upgraded binary reported $actual; expected $version" >&2; exit 5; }',
  ].join("\n")
}

export interface Interface {
  readonly info: () => Effect.Effect<Info>
  readonly method: () => Effect.Effect<Method>
  readonly latest: (method?: Method) => Effect.Effect<string>
  readonly upgrade: (method: Method, target: string) => Effect.Effect<void, UpgradeFailedError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Installation") {}

export const use = serviceUse(Service)

const layer: Layer.Layer<Service, never, HttpClient.HttpClient | AppProcess.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    const httpOk = HttpClient.filterStatusOk(withTransientReadRetry(http))
    const appProcess = yield* AppProcess.Service

    const text = Effect.fnUntraced(
      function* (cmd: string[]) {
        const result = yield* appProcess.run(ChildProcess.make(cmd[0], cmd.slice(1), { extendEnv: true }))
        return result.stdout.toString("utf8")
      },
      Effect.catch(() => Effect.succeed("")),
    )

    const upgradeScriptShell = Effect.fnUntraced(function* () {
      const bashVersion = yield* text(["bash", "--version"])
      if (bashVersion) return "bash"
      return "sh"
    })

    const upgradeDirect = Effect.fnUntraced(function* (target: string) {
      const version = normalizedVersion(target)
      if (!semver.valid(version)) {
        return yield* new UpgradeFailedError({ stderr: `Invalid OpenFork release version: ${target}` })
      }
      if (!isDirectInstallPath(process.execPath)) {
        return yield* new UpgradeFailedError({
          stderr: `OpenFork cannot update this installation in place. Download the matching release from ${PRODUCT_RELEASES_URL}.`,
        })
      }

      const shell = yield* upgradeScriptShell()
      const body = new TextEncoder().encode(openForkDirectUpgradeScript({ version, target: process.execPath }))
      const processResult = yield* appProcess
        .run(
          ChildProcess.make(shell, [], {
            stdin: Stream.make(body),
            extendEnv: true,
          }),
        )
        .pipe(
          Effect.mapError(
            () => new UpgradeFailedError({ stderr: "OpenFork direct upgrade could not start the installer shell." }),
          ),
        )

      if (processResult.exitCode !== 0) {
        return yield* new UpgradeFailedError({
          stderr: `OpenFork direct upgrade failed (exit code ${processResult.exitCode}).`,
        })
      }

      yield* Effect.logInfo("upgraded OpenFork", { method: "curl", target: version })
    })

    const result: Interface = {
      info: Effect.fn("Installation.info")(function* () {
        return {
          version: InstallationVersion,
          latest: yield* result.latest(),
        }
      }),
      method: Effect.fn("Installation.method")(function* () {
        return isDirectInstallPath(process.execPath) ? "curl" : "unknown"
      }),
      latest: Effect.fn("Installation.latest")(function* (_method?: Method) {
        const response = yield* httpOk.execute(
          HttpClientRequest.get(`${PRODUCT_REPOSITORY_API_URL}/releases?per_page=50`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("User-Agent", USER_AGENT),
          ),
        )
        const releases = yield* HttpClientResponse.schemaBodyJson(Schema.Array(GitHubRelease))(response)
        const version = releaseVersionForChannel(releases, InstallationChannel)
        if (!version) {
          return yield* Effect.die(
            new Error(`No published OpenFork release matches channel ${InstallationChannel} at ${PRODUCT_RELEASES_URL}.`),
          )
        }
        return version
      }, Effect.orDie),
      upgrade: Effect.fn("Installation.upgrade")(function* (method: Method, target: string) {
        if (method !== "curl") {
          return yield* new UpgradeFailedError({
            stderr: `OpenFork does not use upstream package-manager channels for self-update. Download the matching release from ${PRODUCT_RELEASES_URL}.`,
          })
        }
        yield* upgradeDirect(target)
      }),
    }

    return Service.of(result)
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [httpClient, AppProcess.node] })

const { runPromise } = makeRuntime(Service, AppNodeBuilder.build(node))

export const latest = (...args: Parameters<Interface["latest"]>) => runPromise((s) => s.latest(...args))
export const method = () => runPromise((s) => s.method())
export const upgrade = (...args: Parameters<Interface["upgrade"]>) => runPromise((s) => s.upgrade(...args))

export * as Installation from "."
